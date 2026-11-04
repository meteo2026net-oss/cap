import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { createWebhookSignature } from "../src/webhook-signature.js";

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
      CAP_DELIVERY_ENABLED: "true",
      CAP_WEBHOOK_INGRESS_ENABLED: "true",
      CAP_WEBHOOK_SECRET: "integration-webhook-secret-that-is-at-least-32-bytes"
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

  const webhookTimestamp = Math.floor(Date.now() / 1000);
  const webhookBody = JSON.stringify({ provider: "synthetic-test", event: "inbound-test", alert: { headline: "Not an operational alert" } });
  const webhookSecret = "integration-webhook-secret-that-is-at-least-32-bytes";
  const webhookSignature = createWebhookSignature(webhookSecret, webhookTimestamp, webhookBody);
  const sendWebhook = (body, timestamp = webhookTimestamp, signature = webhookSignature, contentType = "application/json") =>
    fetch(base + "/api/webhooks/inbound", {
      method: "POST",
      headers: { "Content-Type": contentType, "X-Webhook-Timestamp": String(timestamp), "X-Webhook-Signature": signature },
      body
    });
  const acceptedWebhook = await sendWebhook(webhookBody);
  assert.equal(acceptedWebhook.status, 202, "valid signed webhook should be accepted into the inbox");
  const acceptedWebhookData = await acceptedWebhook.json();
  assert.equal(acceptedWebhookData.accepted, true);
  assert.equal(acceptedWebhookData.status, "pending");
  assert.equal(acceptedWebhookData.action, "manual_review_required");
  assert.ok(Number.isInteger(acceptedWebhookData.inbox_id));
  const duplicateWebhook = await sendWebhook(webhookBody);
  assert.equal(duplicateWebhook.status, 401, "a replayed signed webhook must be rejected");
  const tamperedBody = await sendWebhook(webhookBody + " ");
  assert.equal(tamperedBody.status, 401, "body tampering must invalidate the signature");
  const staleTimestamp = webhookTimestamp - 301;
  const staleSignature = createWebhookSignature(webhookSecret, staleTimestamp, webhookBody);
  const staleWebhook = await sendWebhook(webhookBody, staleTimestamp, staleSignature);
  assert.equal(staleWebhook.status, 401, "stale signed webhooks must be rejected");
  const malformedTimestamp = await sendWebhook(webhookBody, "not-a-time", webhookSignature);
  assert.equal(malformedTimestamp.status, 400, "malformed timestamps must be rejected");
  const malformedJsonBody = "{invalid-json";
  const malformedJsonSignature = createWebhookSignature(webhookSecret, webhookTimestamp, malformedJsonBody);
  const malformedJson = await sendWebhook(malformedJsonBody, webhookTimestamp, malformedJsonSignature);
  assert.equal(malformedJson.status, 400, "signed non-JSON payloads must be rejected");
  const unsupportedContentType = await sendWebhook(webhookBody, webhookTimestamp, webhookSignature, "text/plain");
  assert.equal(unsupportedContentType.status, 415, "webhook ingress must require JSON content type");

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

  assert.equal((await request("/api/webhooks/inbox", { token: forecaster })).status, 403,
    "forecasters must not inspect inbound webhook messages");
  const webhookInbox = await request("/api/webhooks/inbox?status=pending", { token: reviewer });
  assert.equal(webhookInbox.status, 200, "reviewers should inspect pending inbound webhook messages");
  assert.ok(webhookInbox.data.messages.some(item => item.id === acceptedWebhookData.inbox_id));
  const inboxMessage = webhookInbox.data.messages.find(item => item.id === acceptedWebhookData.inbox_id);
  assert.equal(inboxMessage.payload.provider, "synthetic-test");
  const reviewedInboxMessage = await request(`/api/webhooks/inbox/${acceptedWebhookData.inbox_id}/review`, {
    token: reviewer, method: "PATCH", body: { status: "reviewed", note: "Synthetic integration test reviewed" }
  });
  assert.equal(reviewedInboxMessage.status, 200);
  assert.equal(reviewedInboxMessage.data.status, "reviewed");
  assert.equal(reviewedInboxMessage.data.reviewer_username, "reviewer1", "review response should identify the authenticated reviewer");
  const repeatedReview = await request(`/api/webhooks/inbox/${acceptedWebhookData.inbox_id}/review`, {
    token: reviewer, method: "PATCH", body: { status: "rejected" }
  });
  assert.equal(repeatedReview.status, 409, "reviewed webhook messages must not be silently reclassified");
  const secondWebhookBody = JSON.stringify({ provider: "synthetic-test", event: "second-inbound-test" });
  const secondWebhookSignature = createWebhookSignature(webhookSecret, webhookTimestamp, secondWebhookBody);
  const secondWebhookResponse = await sendWebhook(secondWebhookBody, webhookTimestamp, secondWebhookSignature);
  assert.equal(secondWebhookResponse.status, 202);
  const secondWebhookData = await secondWebhookResponse.json();
  const rejectedInboxMessage = await request(`/api/webhooks/inbox/${secondWebhookData.inbox_id}/review`, {
    token: reviewer, method: "PATCH", body: { status: "rejected", note: "Synthetic test rejection" }
  });
  assert.equal(rejectedInboxMessage.status, 200);
  assert.equal(rejectedInboxMessage.data.status, "rejected");

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
  const missingLeaseReceipt = await request(`/api/delivery/outbox/${queuedDelivery.id}/receipt`, {
    token: publisher, method: "POST", body: { status: "failed", details: "Missing lease token" }
  });
  assert.equal(missingLeaseReceipt.status, 400, "receipt API must require a lease token");
  const failedReceipt = await request(`/api/delivery/outbox/${queuedDelivery.id}/receipt`, {
    token: publisher, method: "POST", body: { status: "failed", leaseToken: claimedDelivery.data.delivery.lease_token, details: "Synthetic test failure" }
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
  const staleReceipt = await request(`/api/delivery/outbox/${queuedDelivery.id}/receipt`, {
    token: publisher, method: "POST", body: { status: "delivered", leaseToken: claimedDelivery.data.delivery.lease_token }
  });
  assert.equal(staleReceipt.status, 409, "a receipt from an earlier claim must not affect a later delivery attempt");
  const deliveredReceipt = await request(`/api/delivery/outbox/${queuedDelivery.id}/receipt`, {
    token: publisher, method: "POST", body: { status: "delivered", leaseToken: retryClaim.data.delivery.lease_token, externalId: "synthetic-provider-id" }
  });
  assert.equal(deliveredReceipt.status, 200);
  assert.equal(deliveredReceipt.data.delivery.status, "delivered");

  const inboxDatabase = new Database(path.join(cwd, "storage", "cap.sqlite"));
  try {
    const inboxRow = inboxDatabase.prepare("SELECT source_timestamp,payload_json,status,reviewed_by FROM webhook_inbox WHERE id=?").get(acceptedWebhookData.inbox_id);
    assert.ok(inboxRow, "accepted webhook should be persisted in the inbox");
    assert.equal(inboxRow.source_timestamp, webhookTimestamp);
    assert.equal(inboxRow.status, "reviewed", "review decision should be persisted after reviewer action");
    assert.equal(inboxRow.reviewed_by, (await inboxDatabase.prepare("SELECT id FROM users WHERE username=?").get("reviewer1")).id,
      "reviewer identity should be persisted with the inbox decision");
    assert.equal(JSON.parse(inboxRow.payload_json).provider, "synthetic-test");
    assert.equal(inboxDatabase.prepare("SELECT COUNT(*) AS count FROM webhook_inbox").get().count, 2,
      "only the two valid unique webhooks should enter the inbox");
  } finally {
    inboxDatabase.close();
  }

  assert.equal((await request("/api/webhooks/inbox?before_id=0", { token: reviewer })).status, 400,
    "zero is not a valid inbox cursor");
  assert.equal((await request("/api/webhooks/inbox?before_id=1.5", { token: reviewer })).status, 400,
    "fractional inbox cursors must be rejected");
  const paginationDatabase = new Database(path.join(cwd, "storage", "cap.sqlite"));
  try {
    const addInboxRow = paginationDatabase.prepare(
      "INSERT INTO webhook_inbox (source_timestamp,signature_hash,payload_json,status) VALUES (?,?,?,'pending')"
    );
    const addPageRows = paginationDatabase.transaction(() => {
      for (let index = 0; index < 101; index++) {
        addInboxRow.run(webhookTimestamp, "pagination-test-" + index, JSON.stringify({ page_test: index }));
      }
    });
    addPageRows();
  } finally {
    paginationDatabase.close();
  }
  const firstInboxPage = await request("/api/webhooks/inbox?status=pending", { token: reviewer });
  assert.equal(firstInboxPage.status, 200);
  assert.equal(firstInboxPage.data.messages.length, 100);
  assert.equal(firstInboxPage.data.has_more, true);
  assert.ok(Number.isSafeInteger(firstInboxPage.data.next_before_id));
  const secondInboxPage = await request(
    "/api/webhooks/inbox?status=pending&before_id=" + firstInboxPage.data.next_before_id,
    { token: reviewer }
  );
  assert.equal(secondInboxPage.status, 200);
  assert.equal(secondInboxPage.data.messages.length, 1);
  assert.equal(secondInboxPage.data.has_more, false);
  assert.equal(secondInboxPage.data.next_before_id, null);
  assert.ok(secondInboxPage.data.messages[0].id < firstInboxPage.data.messages.at(-1).id,
    "cursor pagination must return only older inbox rows");

  const directDatabase = new Database(path.join(cwd, "storage", "cap.sqlite"));
  try {
    assert.throws(() => directDatabase.prepare("UPDATE delivery_outbox SET lease_token='00000000-0000-4000-8000-000000000000' WHERE alert_id=?").run(actualRow.id),
      /Plaintext delivery lease tokens are forbidden/, "database triggers must prevent plaintext lease-token storage");
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
  assert.ok(deadLetterRow.data.counts && Number.isInteger(deadLetterRow.data.counts.dead_letter),
    "outbox API should expose database-wide status counts");
  assert.ok(deadLetterRow.data.counts.dead_letter >= 1,
    "database-wide dead-letter count should include exhausted stale leases");
  const allOutbox = await request("/api/delivery/outbox", { token: publisher });
  assert.equal(allOutbox.status, 200);
  assert.ok(Number.isInteger(allOutbox.data.counts.delivered),
    "outbox summary should include delivered receipts separately");

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
