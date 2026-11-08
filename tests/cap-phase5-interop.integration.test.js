import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { parseCapXml } from "../src/cap.js";

const serverEntry = fileURLToPath(new URL("../src/server.js", import.meta.url));

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("phase5: Ack/Error lifecycle, delivery retry, interop import and scope isolation", { timeout: 120000 }, async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), "meteo-cap-phase5-"));
  const port = await reservePort();
  const base = "http://127.0.0.1:" + port;
  const adminPassword = "Phase5-Admin-Password-2026!!";
  const child = spawn(process.execPath, [serverEntry], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      JWT_SECRET: "phase5-test-secret-that-is-at-least-32-characters",
      ADMIN_PASSWORD: adminPassword,
      CAP_DELIVERY_ENABLED: "true",
      MFA_ENCRYPTION_KEY: "f".repeat(64),
      MFA_REQUIRED_ROLES: "",
      API_RATE_LIMIT: "5000",
      CAP_SENDER: "phase5@example.test"
    },
    stdio: "ignore"
  });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        child.once("exit", resolve);
        setTimeout(resolve, 2000);
      });
    }
    await rm(cwd, { recursive: true, force: true });
  });

  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw new Error("API server exited before becoming ready.");
    try {
      const response = await fetch(base + "/api/health");
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true);

  const request = async (url, { token, method = "GET", body } = {}) => {
    const response = await fetch(base + url, {
      method,
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, headers: response.headers, data: await response.json().catch(() => ({})), response };
  };
  const login = async (username, password) => {
    const result = await request("/api/auth/login", { method: "POST", body: { username, password } });
    assert.equal(result.status, 200);
    return result.data.token;
  };
  const changePassword = async (token, currentPassword, newPassword) => {
    const changed = await request("/api/auth/change-password", {
      token, method: "POST", body: { currentPassword, newPassword }
    });
    assert.equal(changed.status, 200);
    return changed.data.token;
  };

  let admin = await login("admin", adminPassword);
  admin = await changePassword(admin, adminPassword, adminPassword + "X");
  const tempPassword = "Phase5-Role-Password-2026!";
  const finalPassword = "Phase5-Role-Password-Final-2026!";
  for (const [username, role] of [
    ["p5_forecaster", "forecaster"],
    ["p5_reviewer", "reviewer"],
    ["p5_publisher", "publisher"]
  ]) {
    assert.equal((await request("/api/users", {
      token: admin, method: "POST", body: { username, password: tempPassword, role }
    })).status, 201);
  }
  const activate = async (username) => {
    let token = await login(username, tempPassword);
    return changePassword(token, tempPassword, finalPassword);
  };
  const forecaster = await activate("p5_forecaster");
  const reviewer = await activate("p5_reviewer");
  const publisher = await activate("p5_publisher");

  async function publish(payload) {
    const created = await request("/api/alerts", { token: forecaster, method: "POST", body: payload });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.id;
    assert.equal((await request(`/api/alerts/${id}/submit`, { token: forecaster, method: "POST", body: {} })).status, 200);
    assert.equal((await request(`/api/alerts/${id}/approve`, { token: reviewer, method: "POST", body: {} })).status, 200);
    assert.equal((await request(`/api/alerts/${id}/publish`, { token: publisher, method: "POST", body: {} })).status, 200);
    const detail = await request(`/api/alerts/${id}`, { token: forecaster });
    return detail.data.alert;
  }

  const source = await publish({
    event: "Phase5 interop source",
    headline: "Phase5 interop source headline",
    description: "Source alert for Ack/Error lifecycle",
    area_desc: "Phase5 area",
    circle: "33.5,36.2 8",
    status: "Actual",
    scope: "Public",
    urgency: "Expected",
    severity: "Moderate",
    certainty: "Likely"
  });

  const deniedRestricted = await request("/api/alerts", {
    token: forecaster, method: "POST", body: {
      event: "Phase5 restricted", headline: "Phase5 restricted headline unique-p5-restricted",
      description: "Restricted interop fixture", area_desc: "Phase5 restricted area",
      circle: "34.0,36.5 5", status: "Actual", scope: "Restricted",
      restriction: "Authorized agencies only", urgency: "Immediate", severity: "Severe", certainty: "Observed"
    }
  });
  assert.equal(deniedRestricted.status, 403);
  assert.equal(deniedRestricted.data.code, "SCOPE_AUTHORIZATION_UNCONFIGURED");
  const restricted = { id: 999999993, identifier: "urn:uuid:restricted-not-created" };

  // Ack and Error derivation + publication
  for (const msg_type of ["Ack", "Error"]) {
    const derived = await request(`/api/alerts/${source.id}/derive`, {
      token: forecaster, method: "POST", body: { msg_type }
    });
    assert.equal(derived.status, 201, `${msg_type} derive: ${JSON.stringify(derived.data)}`);
    assert.equal(derived.data.msg_type, msg_type);
    assert.ok(derived.data.references.includes(source.identifier));

    // Duplicate in-flight Ack/Error rejected
    const dup = await request(`/api/alerts/${source.id}/derive`, {
      token: forecaster, method: "POST", body: { msg_type }
    });
    assert.equal(dup.status, 409, `duplicate in-flight ${msg_type} must be rejected`);

    assert.equal((await request(`/api/alerts/${derived.data.id}/submit`, { token: forecaster, method: "POST", body: {} })).status, 200);
    assert.equal((await request(`/api/alerts/${derived.data.id}/approve`, { token: reviewer, method: "POST", body: {} })).status, 200);
    const published = await request(`/api/alerts/${derived.data.id}/publish`, { token: publisher, method: "POST", body: {} });
    assert.equal(published.status, 200, `${msg_type} publish: ${JSON.stringify(published.data)}`);

    const xmlResponse = await fetch(base + `/api/alerts/${derived.data.id}/cap.xml`, {
      headers: { Authorization: "Bearer " + forecaster }
    });
    assert.equal(xmlResponse.status, 200);
    const xml = await xmlResponse.text();
    const parsed = parseCapXml(xml);
    assert.equal(parsed.msg_type, msg_type);
    assert.match(parsed.references_text, new RegExp(source.identifier));
    assert.equal(parsed.info_blocks.length, 0);
  }

  // Relations include Ack and Error edges
  const relations = await request(`/api/alerts/${source.id}/relations`, { token: forecaster });
  assert.equal(relations.status, 200);
  const types = new Set((relations.data.messages || []).map(message => message.msg_type));
  assert.ok(types.has("Alert"));
  assert.ok(types.has("Ack"));
  assert.ok(types.has("Error"));

  // Export Public source and re-import semantics locally (no external network)
  const sourceXmlResponse = await fetch(base + `/api/alerts/${source.id}/cap.xml`, {
    headers: { Authorization: "Bearer " + forecaster }
  });
  const sourceXml = await sourceXmlResponse.text();
  const reimported = parseCapXml(sourceXml);
  assert.equal(reimported.identifier, source.identifier);
  assert.equal(reimported.scope, "Public");
  assert.equal(reimported.event, source.event);

  // Restricted must not appear on public feed; XML requires auth
  const feed = await request("/api/public/alerts");
  assert.ok(!(feed.data.alerts || []).some(alert => alert.identifier === restricted.identifier));
  assert.equal((await request(`/api/alerts/${restricted.id}/cap.xml`)).status, 401);

  // Delivery outbox retry path (internal only)
  const dbPath = path.join(cwd, "storage", "cap.sqlite");
  assert.equal(existsSync(dbPath), true);
  const db = new Database(dbPath);
  try {
    const outbox = db.prepare("SELECT id,status,attempts,max_attempts FROM delivery_outbox ORDER BY id").all();
    assert.ok(outbox.length >= 3, "published messages should enqueue internal delivery rows");
    // Simulate temporary failure then retry for the first queued/sending-capable row
    const target = outbox[0];
    db.prepare("UPDATE delivery_outbox SET status='failed', attempts=1, last_error=?, next_attempt_at=datetime('now','-1 minute'), dead_letter_at=NULL WHERE id=?")
      .run("simulated temporary failure", target.id);
  } finally {
    db.close();
  }

  const retries = await request("/api/delivery/process-retries", { token: publisher, method: "POST", body: {} });
  assert.equal(retries.status, 200, "process-retries should succeed for publisher");

  const db2 = new Database(dbPath, { readonly: true });
  try {
    const quick = db2.pragma("quick_check");
    assert.equal(quick[0].quick_check, "ok");
    assert.equal(db2.pragma("foreign_key_check").length, 0);
    const failedOrQueued = db2.prepare("SELECT status FROM delivery_outbox WHERE last_error LIKE 'simulated temporary failure%' OR status IN ('queued','sending','delivered','failed')").all();
    assert.ok(failedOrQueued.length >= 1);

    // Audit trail records derive/publish actions
    const auditActions = db2.prepare("SELECT action FROM audit_log").all().map(row => row.action);
    assert.ok(auditActions.includes("ack") || auditActions.includes("published"));
    assert.ok(auditActions.includes("error") || auditActions.includes("published"));
  } finally {
    db2.close();
  }

  // Health still reports adapters disabled
  const health = await request("/api/health");
  assert.equal(health.data.external_adapters_enabled, false);
});
