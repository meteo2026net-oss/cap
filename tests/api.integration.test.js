import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
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

test("API enforces role separation, public-feed filtering and account deactivation", { timeout: 30000 }, async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), "meteo-cap-api-"));
  const port = await reservePort();
  const base = "http://127.0.0.1:" + port;
  const child = spawn(process.execPath, [serverEntry], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      JWT_SECRET: "integration-test-secret-that-is-at-least-32-characters",
      ADMIN_PASSWORD: "Integration-Test-Admin-Password-2026",
      CAP_DELIVERY_ENABLED: "true"
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
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error("API server exited before becoming ready.");
    try {
      const response = await fetch(base + "/api/health");
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, "API server should become ready");

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
    const result = await request("/api/auth/login", {
      method: "POST", body: { username, password }
    });
    assert.equal(result.status, 200, "login should succeed for " + username);
    return result.data.token;
  };

  const admin = await login("admin", "Integration-Test-Admin-Password-2026");
  const createUser = async (username, role) => {
    const result = await request("/api/users", {
      token: admin, method: "POST",
      body: { username, role, password: "Temporary-Password-2026!" }
    });
    assert.equal(result.status, 201, "user should be created: " + username);
    return result.data.id;
  };

  await createUser("forecaster1", "forecaster");
  await createUser("reviewer1", "reviewer");
  await createUser("publisher1", "publisher");
  const disabledId = await createUser("disabled1", "viewer");

  const forecaster = await login("forecaster1", "Temporary-Password-2026!");
  const reviewer = await login("reviewer1", "Temporary-Password-2026!");
  const publisher = await login("publisher1", "Temporary-Password-2026!");

  const invalidCapStatus = await request("/api/alerts", {
    token: forecaster, method: "POST",
    body: {
      event: "Invalid draft status", headline: "Invalid CAP status",
      description: "Draft is an internal workflow state, not a CAP status.",
      area_desc: "Synthetic test area", circle: "33.5,36.2 8",
      status: "Draft"
    }
  });
  assert.equal(invalidCapStatus.status, 400,
    "Draft must not be accepted as a CAP status value");

  assert.equal((await request("/api/users", { token: forecaster })).status, 403,
    "forecasters must not administer users");

  const createAndPublish = async (status, expires = "") => {
    const created = await request("/api/alerts", {
      token: forecaster, method: "POST",
      body: {
        event: "Integration test rainfall",
        headline: "Synthetic test warning",
        description: "Synthetic integration test data only",
        area_desc: "Synthetic test area",
        circle: "33.5,36.2 8",
        category: "Met",
        urgency: "Expected",
        severity: "Moderate",
        certainty: "Likely",
        status,
        expires,
        scope: "Public"
      }
    });
    assert.equal(created.status, 201, "forecaster should create a draft");
    const id = created.data.id;

    assert.equal((await request(`/api/alerts/${id}/submit`, {
      token: forecaster, method: "POST", body: {}
    })).status, 200);
    assert.equal((await request(`/api/alerts/${id}/approve`, {
      token: forecaster, method: "POST", body: {}
    })).status, 403, "creator cannot approve their own warning");
    assert.equal((await request(`/api/alerts/${id}/approve`, {
      token: reviewer, method: "POST", body: {}
    })).status, 200);
    assert.equal((await request(`/api/alerts/${id}/publish`, {
      token: reviewer, method: "POST", body: {}
    })).status, 403, "approver cannot publish the same warning");
    assert.equal((await request(`/api/alerts/${id}/publish`, {
      token: publisher, method: "POST", body: {}
    })).status, 200);
    return created.data.identifier;
  };

  const actualIdentifier = await createAndPublish("Actual");
  const original = await request("/api/alerts", { token: forecaster });
  assert.equal(original.status, 200, "authenticated alert history should be available");
  const actualRow = original.data.alerts.find(alert => alert.identifier === actualIdentifier);
  assert.ok(actualRow, "published warning should remain in authenticated history");

  assert.equal((await request("/api/delivery/outbox", { token: forecaster })).status, 403,
    "forecasters must not access the delivery outbox");
  const outbox = await request("/api/delivery/outbox", { token: publisher });
  assert.equal(outbox.status, 200);
  assert.equal(outbox.data.external_adapters_enabled, false, "external delivery must remain disabled without a real adapter");
  const queuedDelivery = outbox.data.deliveries.find(item => item.alert_id === actualRow.id && item.channel === "cap_feed");
  assert.ok(queuedDelivery, "publishing must atomically enqueue an internal CAP feed delivery");
  assert.equal(queuedDelivery.status, "queued");
  const claimedDelivery = await request(`/api/delivery/outbox/${queuedDelivery.id}/claim`, {
    token: publisher, method: "POST", body: {}
  });
  assert.equal(claimedDelivery.status, 200);
  assert.equal(claimedDelivery.data.delivery.status, "sending");
  assert.equal(claimedDelivery.data.external_adapters_enabled, false);
  assert.match(claimedDelivery.data.delivery.payload, /<alert xmlns=/);
  const failedReceipt = await request(`/api/delivery/outbox/${queuedDelivery.id}/receipt`, {
    token: publisher, method: "POST", body: { status: "failed", details: "Synthetic test failure" }
  });
  assert.equal(failedReceipt.status, 200);
  assert.equal(failedReceipt.data.delivery.status, "failed");
  assert.equal((await request(`/api/delivery/outbox/${queuedDelivery.id}/retry`, {
    token: publisher, method: "POST", body: {}
  })).status, 200);
  const retryClaim = await request(`/api/delivery/outbox/${queuedDelivery.id}/claim`, {
    token: publisher, method: "POST", body: {}
  });
  assert.equal(retryClaim.status, 200);
  assert.equal(retryClaim.data.delivery.attempts, 2);
  const deliveredReceipt = await request(`/api/delivery/outbox/${queuedDelivery.id}/receipt`, {
    token: publisher, method: "POST", body: { status: "delivered", externalId: "synthetic-provider-id" }
  });
  assert.equal(deliveredReceipt.status, 200);
  assert.equal(deliveredReceipt.data.delivery.status, "delivered");

  const directDatabase = new Database(path.join(cwd, "storage", "cap.sqlite"));
  try {
    assert.throws(() => directDatabase.prepare("UPDATE alerts SET status='Draft' WHERE id=?").run(actualRow.id),
      /Invalid CAP 1.2 status/, "database triggers must reject non-standard CAP status values");
    directDatabase.prepare("UPDATE delivery_outbox SET status='sending',last_attempt_at=datetime('now','-30 minutes') WHERE alert_id=? AND channel='cap_feed'").run(actualRow.id);
  } finally {
    directDatabase.close();
  }
  const recovery = await request("/api/delivery/recover-stale", {
    token: publisher, method: "POST", body: { staleMinutes: 10 }
  });
  assert.equal(recovery.status, 200);
  assert.equal(recovery.data.recovered_count, 1, "stale sending jobs should be recovered to queued");
  const deadLetterDatabase = new Database(path.join(cwd, "storage", "cap.sqlite"));
  try {
    deadLetterDatabase.prepare("UPDATE delivery_outbox SET status='sending',attempts=max_attempts,dead_letter_at=NULL,last_attempt_at=datetime('now','-30 minutes'),next_attempt_at=NULL WHERE alert_id=? AND channel='cap_feed'").run(actualRow.id);
  } finally {
    deadLetterDatabase.close();
  }
  const exhaustedLease = await request("/api/delivery/recover-stale", {
    token: publisher, method: "POST", body: { staleMinutes: 10 }
  });
  assert.equal(exhaustedLease.status, 200);
  assert.equal(exhaustedLease.data.recovered_count, 0);
  assert.equal(exhaustedLease.data.dead_lettered_count, 1,
    "stale leases at their maximum attempt count must be dead-lettered, not counted as recovered");

  assert.equal((await request("/api/delivery/process-retries", {
    token: forecaster, method: "POST", body: {}
  })).status, 403, "forecasters must not process delivery retries");
  const processedRetries = await request("/api/delivery/process-retries", {
    token: publisher, method: "POST", body: {}
  });
  assert.equal(processedRetries.status, 200, "publishers may process due internal retries");
  assert.equal(processedRetries.data.ok, true);
  const deadLetterRow = await request("/api/delivery/outbox?status=dead_letter", { token: publisher });
  assert.equal(deadLetterRow.status, 200);
  assert.ok(Array.isArray(deadLetterRow.data.deliveries));
  assert.ok(deadLetterRow.data.deliveries.some(item => item.alert_id === actualRow.id),
    "dead-letter filter should expose exhausted entries without leaking them into other status filters");

  assert.equal((await request("/api/delivery/recover-stale", {
    token: forecaster, method: "POST", body: { staleMinutes: 10 }
  })).status, 403, "forecasters must not run delivery recovery");

  const capXml = await fetch(base + "/api/alerts/" + actualRow.id + "/cap.xml", {
    headers: { Authorization: "Bearer " + forecaster }
  });
  assert.equal(capXml.status, 200, "authorized CAP XML export should succeed");
  assert.ok((capXml.headers.get("content-type") || "").includes("application/xml"));
  assert.match(await capXml.text(), /<alert xmlns=/);

  for (const msg_type of ["Update", "Cancel"]) {
    const derived = await request(`/api/alerts/${actualRow.id}/derive`, {
      token: forecaster, method: "POST", body: { msg_type }
    });
    assert.equal(derived.status, 201, msg_type + " should create a new draft");
    assert.equal(derived.data.status, "Test", "derived messages must remain in Test status");
    assert.equal(derived.data.workflow, "draft");
    assert.ok(derived.data.references.includes(actualIdentifier),
      msg_type + " must reference the original CAP identifier");
  }

  assert.equal((await request("/api/audit", { token: forecaster })).status, 403,
    "forecasters must not read restricted audit history");
  assert.equal((await request("/api/audit", { token: reviewer })).status, 200,
    "reviewers should be able to inspect audit history");
  const auditStatus = await request("/api/audit/verify", { token: reviewer });
  assert.equal(auditStatus.status, 200);
  assert.equal(auditStatus.data.valid, true, "API should verify the cryptographic audit chain");
  assert.ok(auditStatus.data.verified_entries > 0);

  const geoFeed = await request("/api/public/alerts.geojson");
  assert.equal(geoFeed.status, 200);
  assert.ok(geoFeed.data.features.some(feature => feature.properties?.identifier === actualIdentifier),
    "published Actual/Public warning should appear in public GeoJSON");

  const testIdentifier = await createAndPublish("Test");
  const publicFeed = await request("/api/public/alerts");
  assert.equal(publicFeed.status, 200);
  assert.ok(publicFeed.data.alerts.some(alert => alert.identifier === actualIdentifier),
    "published Actual/Public warning should be visible in the public feed");
  assert.ok(!publicFeed.data.alerts.some(alert => alert.identifier === testIdentifier),
    "published Test warning must not appear in the public feed");

  const expiredIdentifier = await createAndPublish("Actual", "2020-01-01T00:00:00Z");
  const feedAfterExpiry = await request("/api/public/alerts");
  assert.ok(!feedAfterExpiry.data.alerts.some(alert => alert.identifier === expiredIdentifier),
    "expired Actual/Public warnings must be excluded from the public JSON feed");
  const geoAfterExpiry = await request("/api/public/alerts.geojson");
  assert.ok(!geoAfterExpiry.data.features.some(feature => feature.properties?.identifier === expiredIdentifier),
    "expired Actual/Public warnings must be excluded from the public GeoJSON feed");

  assert.equal((await request(`/api/users/${disabledId}/status`, {
    token: admin, method: "PATCH", body: { active: false }
  })).status, 200);
  assert.equal((await request("/api/auth/login", {
    method: "POST", body: { username: "disabled1", password: "Temporary-Password-2026!" }
  })).status, 401, "deactivated users cannot log in");

  const passwordChange = await request("/api/auth/change-password", {
    token: forecaster, method: "POST",
    body: {
      currentPassword: "Temporary-Password-2026!",
      newPassword: "Updated-Temporary-Password-2026!"
    }
  });
  assert.equal(passwordChange.status, 200, "password change should succeed");
  assert.equal(passwordChange.data.session_revoked_for_other_devices, true);
  assert.equal((await request("/api/me", { token: forecaster })).status, 401,
    "password changes must revoke previously issued access tokens");
  assert.equal((await request("/api/me", { token: passwordChange.data.token })).status, 200,
    "password change should return a replacement session token");
  assert.equal((await request("/api/auth/login", {
    method: "POST", body: { username: "forecaster1", password: "Temporary-Password-2026!" }
  })).status, 401, "the previous password must stop working immediately");
  assert.equal((await request("/api/auth/login", {
    method: "POST", body: { username: "forecaster1", password: "Updated-Temporary-Password-2026!" }
  })).status, 200, "the new password should work immediately");

  const users = await request("/api/users", { token: admin });
  const adminUser = users.data.users.find(user => user.username === "admin");
  assert.ok(adminUser);
  assert.equal((await request(`/api/users/${adminUser.id}/status`, {
    token: admin, method: "PATCH", body: { active: false }
  })).status, 409, "the active administrator cannot deactivate itself");
});
