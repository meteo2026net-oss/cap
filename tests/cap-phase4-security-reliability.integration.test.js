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
import { createDatabaseBackup, restoreDatabaseBackup } from "../src/backup-utils.js";

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

async function startServer(t, cwd, envExtra = {}) {
  const port = await reservePort();
  const base = "http://127.0.0.1:" + port;
  const adminPassword = "Phase4-Admin-Password-2026!!";
  const child = spawn(process.execPath, [serverEntry], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      JWT_SECRET: "phase4-test-secret-that-is-at-least-32-characters",
      ADMIN_PASSWORD: adminPassword,
      CAP_DELIVERY_ENABLED: "true",
      MFA_ENCRYPTION_KEY: "e".repeat(64),
      MFA_REQUIRED_ROLES: "",
      API_RATE_LIMIT: "5000",
      CAP_SENDER: "phase4@example.test",
      ...envExtra
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
  assert.equal(ready, true, "phase4 API server should become ready");
  return { base, child, adminPassword, port };
}

function makeClient(base) {
  const request = async (url, { token, method = "GET", body } = {}) => {
    const response = await fetch(base + url, {
      method,
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, headers: response.headers, data: await response.json().catch(() => ({})) };
  };
  const login = async (username, password) => {
    const result = await request("/api/auth/login", { method: "POST", body: { username, password } });
    assert.equal(result.status, 200, "login should succeed for " + username);
    return result.data.token;
  };
  const changePassword = async (token, currentPassword, newPassword) => {
    const changed = await request("/api/auth/change-password", {
      token, method: "POST", body: { currentPassword, newPassword }
    });
    assert.equal(changed.status, 200, "password change should succeed: " + JSON.stringify(changed.data));
    return changed.data.token;
  };
  return { request, login, changePassword };
}

async function provisionRoles(client, adminPassword) {
  let admin = await client.login("admin", adminPassword);
  admin = await client.changePassword(admin, adminPassword, adminPassword + "X");
  const tempPassword = "Phase4-Role-Password-2026!";
  const finalPassword = "Phase4-Role-Password-Final-2026!";
  for (const [username, role] of [
    ["p4_forecaster", "forecaster"],
    ["p4_reviewer", "reviewer"],
    ["p4_publisher", "publisher"],
    ["p4_viewer", "viewer"]
  ]) {
    const created = await client.request("/api/users", {
      token: admin, method: "POST", body: { username, password: tempPassword, role }
    });
    assert.equal(created.status, 201, "create " + role);
  }
  const activate = async (username) => {
    let token = await client.login(username, tempPassword);
    return client.changePassword(token, tempPassword, finalPassword);
  };
  return {
    admin,
    forecaster: await activate("p4_forecaster"),
    reviewer: await activate("p4_reviewer"),
    publisher: await activate("p4_publisher"),
    viewer: await activate("p4_viewer")
  };
}

async function publishAlert(client, tokens, payload) {
  const created = await client.request("/api/alerts", {
    token: tokens.forecaster, method: "POST", body: payload
  });
  assert.equal(created.status, 201, "create draft: " + JSON.stringify(created.data));
  const id = created.data.id;
  assert.equal((await client.request(`/api/alerts/${id}/submit`, {
    token: tokens.forecaster, method: "POST", body: {}
  })).status, 200);
  assert.equal((await client.request(`/api/alerts/${id}/approve`, {
    token: tokens.reviewer, method: "POST", body: {}
  })).status, 200);
  const published = await client.request(`/api/alerts/${id}/publish`, {
    token: tokens.publisher, method: "POST", body: {}
  });
  assert.equal(published.status, 200, "publish: " + JSON.stringify(published.data));
  const detail = await client.request(`/api/alerts/${id}`, { token: tokens.forecaster });
  assert.equal(detail.status, 200);
  return detail.data.alert;
}

test("phase4: reference integrity, role gates, isolation, backup/restore and restart durability", { timeout: 120000 }, async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), "meteo-cap-phase4-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const { base, child, adminPassword } = await startServer(t, cwd);
  const client = makeClient(base);
  const tokens = await provisionRoles(client, adminPassword);

  // --- Role separation: prevent skipping review/publish stages ---
  const draft = await client.request("/api/alerts", {
    token: tokens.forecaster, method: "POST", body: {
      event: "Phase4 role gate",
      headline: "Phase4 role gate headline",
      description: "Role gate fixture",
      area_desc: "Phase4 area",
      circle: "33.5,36.2 7",
      status: "Test",
      scope: "Public",
      urgency: "Expected",
      severity: "Moderate",
      certainty: "Likely"
    }
  });
  assert.equal(draft.status, 201);
  const draftId = draft.data.id;

  assert.equal((await client.request(`/api/alerts/${draftId}/approve`, {
    token: tokens.reviewer, method: "POST", body: {}
  })).status, 409, "cannot approve before submit");
  assert.equal((await client.request(`/api/alerts/${draftId}/publish`, {
    token: tokens.publisher, method: "POST", body: {}
  })).status, 409, "cannot publish before approve");
  assert.equal((await client.request(`/api/alerts/${draftId}/submit`, {
    token: tokens.reviewer, method: "POST", body: {}
  })).status, 403, "reviewer cannot submit another author's draft");
  assert.equal((await client.request(`/api/alerts/${draftId}/submit`, {
    token: tokens.viewer, method: "POST", body: {}
  })).status, 403, "viewer cannot submit");
  assert.equal((await client.request(`/api/alerts/${draftId}/approve`, {
    token: tokens.publisher, method: "POST", body: {}
  })).status, 403, "publisher cannot approve");
  assert.equal((await client.request(`/api/alerts/${draftId}/publish`, {
    token: tokens.forecaster, method: "POST", body: {}
  })).status, 403, "forecaster cannot publish");

  assert.equal((await client.request(`/api/alerts/${draftId}/submit`, {
    token: tokens.forecaster, method: "POST", body: {}
  })).status, 200);
  assert.equal((await client.request(`/api/alerts/${draftId}/approve`, {
    token: tokens.reviewer, method: "POST", body: {}
  })).status, 200);
  assert.equal((await client.request(`/api/alerts/${draftId}/publish`, {
    token: tokens.reviewer, method: "POST", body: {}
  })).status, 403, "reviewer cannot publish");
  assert.equal((await client.request(`/api/alerts/${draftId}/publish`, {
    token: tokens.publisher, method: "POST", body: {}
  })).status, 200);

  // --- Source must be published before derive ---
  const unreviewed = await client.request("/api/alerts", {
    token: tokens.forecaster, method: "POST", body: {
      event: "Phase4 unreviewed",
      headline: "Phase4 unreviewed headline",
      description: "Unreviewed derive source",
      area_desc: "Phase4 area",
      circle: "33.5,36.2 7",
      status: "Test",
      scope: "Public"
    }
  });
  assert.equal(unreviewed.status, 201);
  assert.equal((await client.request(`/api/alerts/${unreviewed.data.id}/derive`, {
    token: tokens.forecaster, method: "POST", body: { msg_type: "Update" }
  })).status, 409, "derive from non-published source must fail");

  // --- Publish Public/Restricted/Private sources ---
  const publicSource = await publishAlert(client, tokens, {
    event: "Phase4 public source",
    headline: "Phase4 public source headline unique-p4-public",
    description: "Public source for reference checks",
    area_desc: "Phase4 public area",
    circle: "33.5,36.2 7",
    status: "Actual",
    scope: "Public",
    urgency: "Expected",
    severity: "Moderate",
    certainty: "Likely"
  });
  const restrictedSource = await publishAlert(client, tokens, {
    event: "Phase4 restricted source",
    headline: "Phase4 restricted source unique-p4-restricted",
    description: "Restricted source",
    area_desc: "Phase4 restricted area",
    circle: "34.0,36.5 5",
    status: "Actual",
    scope: "Restricted",
    restriction: "Authorized agencies only",
    urgency: "Immediate",
    severity: "Severe",
    certainty: "Observed"
  });
  const privateSource = await publishAlert(client, tokens, {
    event: "Phase4 private source",
    headline: "Phase4 private source unique-p4-private",
    description: "Private source",
    area_desc: "Phase4 private area",
    circle: "33.2,36.1 4",
    status: "Actual",
    scope: "Private",
    addresses: "ops@example.test duty@example.test",
    urgency: "Expected",
    severity: "Minor",
    certainty: "Possible"
  });

  // --- Reference integrity for Update/Cancel ---
  const update = await client.request(`/api/alerts/${publicSource.id}/derive`, {
    token: tokens.forecaster, method: "POST", body: { msg_type: "Update" }
  });
  assert.equal(update.status, 201);
  const expectedReference = [
    publicSource.sender,
    publicSource.identifier,
    publicSource.sent.replace(/\.\d{3}Z$/, "-00:00")
  ].join(",");
  assert.equal(update.data.references, expectedReference,
    "Update references must match source sender,identifier,sent");

  const updateDetail = await client.request(`/api/alerts/${update.data.id}`, { token: tokens.forecaster });
  assert.equal(updateDetail.data.alert.references_text, expectedReference);
  const [refSender, refIdentifier, refSent] = updateDetail.data.alert.references_text.split(",");
  assert.equal(refSender, publicSource.sender);
  assert.equal(refIdentifier, publicSource.identifier);
  assert.equal(
    Math.floor(Date.parse(refSent) / 1000),
    Math.floor(Date.parse(publicSource.sent) / 1000),
    "reference sent must match source sent at second precision"
  );

  // PATCH must not allow forging references_text
  const forge = await client.request(`/api/alerts/${update.data.id}`, {
    token: tokens.forecaster, method: "PATCH",
    body: { references_text: "forged@example.test,urn:uuid:forged,2026-01-01T00:00:00-00:00" }
  });
  assert.equal(forge.status, 400, "references_text is not an editable field");
  const afterForge = await client.request(`/api/alerts/${update.data.id}`, { token: tokens.forecaster });
  assert.equal(afterForge.data.alert.references_text, expectedReference, "forged references must not persist");

  // Publish update and verify relation edge
  assert.equal((await client.request(`/api/alerts/${update.data.id}/submit`, {
    token: tokens.forecaster, method: "POST", body: {}
  })).status, 200);
  assert.equal((await client.request(`/api/alerts/${update.data.id}/approve`, {
    token: tokens.reviewer, method: "POST", body: {}
  })).status, 200);
  assert.equal((await client.request(`/api/alerts/${update.data.id}/publish`, {
    token: tokens.publisher, method: "POST", body: {}
  })).status, 200);

  const relations = await client.request(`/api/alerts/${publicSource.id}/relations`, { token: tokens.forecaster });
  assert.equal(relations.status, 200);
  assert.ok((relations.data.relations || []).some(edge =>
    edge.from_id === publicSource.id &&
    edge.to_id === update.data.id &&
    edge.msg_type === "Update" &&
    edge.reference === expectedReference
  ), "relations must expose validated parent-to-update edge");

  // Cancel once, then reject duplicate cancel
  const cancel1 = await client.request(`/api/alerts/${publicSource.id}/derive`, {
    token: tokens.forecaster, method: "POST", body: { msg_type: "Cancel" }
  });
  assert.equal(cancel1.status, 201);
  assert.equal(cancel1.data.references, expectedReference);
  const cancel2 = await client.request(`/api/alerts/${publicSource.id}/derive`, {
    token: tokens.forecaster, method: "POST", body: { msg_type: "Cancel" }
  });
  assert.equal(cancel2.status, 409, "duplicate cancellation must be rejected");
  assert.equal(cancel2.data.existing_cancel_id, cancel1.data.id);

  // Viewer cannot derive; unauthenticated cannot read CAP XML
  assert.equal((await client.request(`/api/alerts/${publicSource.id}/derive`, {
    token: tokens.viewer, method: "POST", body: { msg_type: "Update" }
  })).status, 403);
  assert.equal((await client.request(`/api/alerts/${restrictedSource.id}/cap.xml`)).status, 401);
  assert.equal((await client.request(`/api/alerts?q=unique-p4-restricted`)).status, 401);
  assert.equal((await client.request(`/api/alerts/export.csv?q=unique-p4-private`)).status, 401);

  // Public feed isolation
  const publicFeed = await client.request("/api/public/alerts");
  assert.equal(publicFeed.status, 200);
  const feedIds = new Set((publicFeed.data.alerts || []).map(alert => alert.identifier));
  assert.ok(feedIds.has(publicSource.identifier));
  assert.ok(!feedIds.has(restrictedSource.identifier));
  assert.ok(!feedIds.has(privateSource.identifier));
  assert.equal(publicFeed.headers.get("cache-control"), "no-store");

  // Invalid inputs rejected without residue
  const beforeBad = (() => {
    const db = new Database(path.join(cwd, "storage", "cap.sqlite"), { readonly: true });
    try { return db.prepare("SELECT COUNT(*) AS n FROM alerts").get().n; }
    finally { db.close(); }
  })();
  assert.equal((await client.request("/api/alerts", {
    token: tokens.forecaster, method: "POST", body: {
      event: "bad",
      headline: "bad",
      description: "bad",
      area_desc: "bad",
      circle: "33,36 5",
      scope: "Restricted",
      status: "Test"
    }
  })).status, 400);
  const afterBad = (() => {
    const db = new Database(path.join(cwd, "storage", "cap.sqlite"), { readonly: true });
    try { return db.prepare("SELECT COUNT(*) AS n FROM alerts").get().n; }
    finally { db.close(); }
  })();
  assert.equal(afterBad, beforeBad, "invalid create must not insert rows");

  // --- Backup and restore to a separate database ---
  const dbPath = path.join(cwd, "storage", "cap.sqlite");
  assert.equal(existsSync(dbPath), true);
  const sourceDb = new Database(dbPath);
  const backupDir = path.join(cwd, "backups");
  const backupFile = await createDatabaseBackup(sourceDb, backupDir);
  sourceDb.close();
  assert.ok(backupFile && existsSync(backupFile), "backup file must be created");

  const restoreTarget = path.join(cwd, "restored", "cap-restored.sqlite");
  const restoreResult = await restoreDatabaseBackup(backupFile, restoreTarget, { force: true });
  assert.ok(restoreResult, "restore should succeed");
  assert.equal(existsSync(restoreTarget), true);

  const restored = new Database(restoreTarget, { readonly: true });
  try {
    const quick = restored.pragma("quick_check");
    assert.equal(quick[0].quick_check, "ok", "restored DB quick_check must pass");
    const fk = restored.pragma("foreign_key_check");
    assert.equal(fk.length, 0, "restored DB foreign_key_check must pass");
    const identifiers = restored.prepare("SELECT identifier, scope FROM alerts WHERE workflow='published'").all();
    assert.ok(identifiers.some(row => row.identifier === publicSource.identifier && row.scope === "Public"));
    assert.ok(identifiers.some(row => row.identifier === restrictedSource.identifier && row.scope === "Restricted"));
    assert.ok(identifiers.some(row => row.identifier === privateSource.identifier && row.scope === "Private"));
  } finally {
    restored.close();
  }

  // --- Process interruption: stop server and restart against same DB ---
  child.kill("SIGTERM");
  await new Promise(resolve => {
    child.once("exit", resolve);
    setTimeout(resolve, 3000);
  });

  const restarted = await startServer(t, cwd, {
    // Preserve existing admin hash by not re-seeding destructive state; same ADMIN_PASSWORD path is fine for login if seed only creates missing admin
  });
  const client2 = makeClient(restarted.base);
  // Admin password was changed earlier; login with rotated password.
  const adminRestart = await client2.login("admin", adminPassword + "X");
  const list = await client2.request("/api/alerts?q=unique-p4-public", { token: adminRestart });
  assert.equal(list.status, 200);
  assert.ok((list.data.alerts || []).some(alert => alert.identifier === publicSource.identifier),
    "published alerts must survive process restart");
  const feedAfterRestart = await client2.request("/api/public/alerts");
  assert.equal(feedAfterRestart.status, 200);
  assert.ok((feedAfterRestart.data.alerts || []).some(alert => alert.identifier === publicSource.identifier));
  assert.ok(!(feedAfterRestart.data.alerts || []).some(alert => alert.identifier === privateSource.identifier));
});
