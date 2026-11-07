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

test("failed CAP validation does not leave partial alert or relation records", { timeout: 90000 }, async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), "meteo-cap-atomic-"));
  const port = await reservePort();
  const base = "http://127.0.0.1:" + port;
  const adminPassword = "Atomic-Test-Admin-Password-2026!";
  const child = spawn(process.execPath, [serverEntry], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      JWT_SECRET: "atomic-test-secret-that-is-at-least-32-characters-long",
      ADMIN_PASSWORD: adminPassword,
      CAP_DELIVERY_ENABLED: "true",
      MFA_ENCRYPTION_KEY: "d".repeat(64),
      MFA_REQUIRED_ROLES: "",
      API_RATE_LIMIT: "5000",
      CAP_SENDER: "atomic@example.test"
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
    return { status: response.status, data: await response.json().catch(() => ({})) };
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
  const tempPassword = "Atomic-Role-Password-2026!";
  const finalPassword = "Atomic-Role-Password-Final-2026!";
  for (const [username, role] of [["atomic_forecaster", "forecaster"], ["atomic_reviewer", "reviewer"], ["atomic_publisher", "publisher"]]) {
    assert.equal((await request("/api/users", {
      token: admin, method: "POST", body: { username, password: tempPassword, role }
    })).status, 201);
  }
  const activate = async (username) => {
    let token = await login(username, tempPassword);
    return changePassword(token, tempPassword, finalPassword);
  };
  const forecaster = await activate("atomic_forecaster");
  const reviewer = await activate("atomic_reviewer");
  const publisher = await activate("atomic_publisher");

  const dbPath = path.join(cwd, "storage", "cap.sqlite");
  assert.equal(existsSync(dbPath), true);
  const countRows = () => {
    const db = new Database(dbPath, { readonly: true });
    try {
      return {
        alerts: db.prepare("SELECT COUNT(*) AS n FROM alerts").get().n,
        versions: db.prepare("SELECT COUNT(*) AS n FROM alert_versions").get().n,
        outbox: db.prepare("SELECT COUNT(*) AS n FROM delivery_outbox").get().n
      };
    } finally {
      db.close();
    }
  };

  const beforeInvalidCreate = countRows();
  const invalidRestricted = await request("/api/alerts", {
    token: forecaster, method: "POST", body: {
      event: "Atomic invalid restricted",
      headline: "Missing restriction text",
      description: "Should be rejected",
      area_desc: "Atomic area",
      circle: "33.5,36.2 8",
      status: "Test",
      scope: "Restricted"
    }
  });
  assert.equal(invalidRestricted.status, 400, "Restricted without restriction must be rejected");
  assert.match(invalidRestricted.data.error || "", /restriction/i);
  assert.deepEqual(countRows(), beforeInvalidCreate, "failed create must not insert alerts or versions");

  const invalidPrivate = await request("/api/alerts", {
    token: forecaster, method: "POST", body: {
      event: "Atomic invalid private",
      headline: "Missing addresses text",
      description: "Should be rejected",
      area_desc: "Atomic area",
      circle: "33.5,36.2 8",
      status: "Test",
      scope: "Private"
    }
  });
  assert.equal(invalidPrivate.status, 400);
  assert.match(invalidPrivate.data.error || "", /addresses/i);
  assert.deepEqual(countRows(), beforeInvalidCreate, "failed private create must not insert rows");

  // Create and publish a valid Public alert, then ensure invalid derive does not leave residue.
  const created = await request("/api/alerts", {
    token: forecaster, method: "POST", body: {
      event: "Atomic public source",
      headline: "Atomic public source headline",
      description: "Valid source for derive atomicity checks",
      area_desc: "Atomic public area",
      circle: "33.5,36.2 8",
      status: "Actual",
      scope: "Public",
      urgency: "Expected",
      severity: "Moderate",
      certainty: "Likely"
    }
  });
  assert.equal(created.status, 201);
  const id = created.data.id;
  assert.equal((await request(`/api/alerts/${id}/submit`, { token: forecaster, method: "POST", body: {} })).status, 200);
  assert.equal((await request(`/api/alerts/${id}/approve`, { token: reviewer, method: "POST", body: {} })).status, 200);
  assert.equal((await request(`/api/alerts/${id}/publish`, { token: publisher, method: "POST", body: {} })).status, 200);

  const beforeBadDerive = countRows();
  const badDerive = await request(`/api/alerts/${id}/derive`, {
    token: forecaster, method: "POST", body: { msg_type: "Alert" }
  });
  assert.equal(badDerive.status, 400, "derive must reject unsupported message types");
  assert.deepEqual(countRows(), beforeBadDerive, "failed derive must not insert derived alerts");

  // Patch a draft to Private without addresses must fail without changing stored scope.
  const draft = await request("/api/alerts", {
    token: forecaster, method: "POST", body: {
      event: "Atomic draft",
      headline: "Atomic draft headline",
      description: "Draft for invalid patch",
      area_desc: "Atomic draft area",
      circle: "33.5,36.2 8",
      status: "Test",
      scope: "Public"
    }
  });
  assert.equal(draft.status, 201);
  const beforePatch = countRows();
  const badPatch = await request(`/api/alerts/${draft.data.id}`, {
    token: forecaster, method: "PATCH", body: { scope: "Private" }
  });
  assert.equal(badPatch.status, 400);
  assert.match(badPatch.data.error || "", /addresses/i);
  assert.equal(countRows().alerts, beforePatch.alerts, "failed patch must not add rows");
  assert.equal(countRows().versions, beforePatch.versions, "failed patch must not add versions");

  const readback = await request(`/api/alerts/${draft.data.id}`, { token: forecaster });
  assert.equal(readback.status, 200);
  assert.equal(readback.data.alert.scope, "Public", "failed Private patch must leave scope unchanged");
});
