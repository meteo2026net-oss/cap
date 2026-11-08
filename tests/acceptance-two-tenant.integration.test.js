import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWebhookSignature } from "../src/webhook-signature.js";
import Database from "better-sqlite3";
import { appendAuditLog } from "../src/audit.js";

const serverEntry = fileURLToPath(new URL("../src/server.js", import.meta.url));

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * Pack scenarios I1–I2, W1–W2, and a Public Test lifecycle slice for two tenants.
 * Does not claim Gate 8 institutional acceptance.
 */
test("acceptance pack: two-tenant webhook isolation and public test lifecycle", { timeout: 120000 }, async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "meteo-cap-accept-"));
  const port = await reservePort();
  const base = "http://127.0.0.1:" + port;
  const adminPassword = "Acceptance-Pack-Admin-Password-2026!";
  const child = spawn(process.execPath, [serverEntry], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      JWT_SECRET: "acceptance-pack-test-secret-at-least-32-characters",
      ADMIN_PASSWORD: adminPassword,
      MFA_ENCRYPTION_KEY: "e".repeat(64),
      MFA_REQUIRED_ROLES: "",
      CAP_WEBHOOK_INGRESS_ENABLED: "true",
      CAP_NON_PUBLIC_RECIPIENT_ACCESS_ENABLED: "true",
      CAP_WEBHOOK_SECRET: "acceptance-pack-legacy-secret-at-least-32-bytes",
      API_RATE_LIMIT: "5000",
      ADMIN_ACCOUNT_MUTATION_LIMIT: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => {
        child.once("exit", resolve);
        setTimeout(resolve, 2000);
      });
    }
    await rm(cwd, { recursive: true, force: true });
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) {
      throw new Error("server exited before ready: " + stderr.slice(-500));
    }
    try {
      if ((await fetch(base + "/api/health")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, "acceptance server should become ready; stderr=" + stderr.slice(-300));

  const request = async (url, { token, method = "GET", body } = {}) => {
    const response = await fetch(base + url, {
      method,
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json().catch(() => ({})) };
  };

  const health = await request("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.data.external_adapters_enabled, false, "external adapters must stay disabled");

  const adminLogin = await request("/api/auth/login", {
    method: "POST",
    body: { username: "admin", password: adminPassword },
  });
  assert.equal(adminLogin.status, 200);
  const admin = adminLogin.data.token;

  const orgA = await request("/api/organizations", {
    method: "POST",
    token: admin,
    body: { slug: "accept-org-a", name: "Acceptance Org A" },
  });
  const orgB = await request("/api/organizations", {
    method: "POST",
    token: admin,
    body: { slug: "accept-org-b", name: "Acceptance Org B" },
  });
  assert.equal(orgA.status, 201);
  assert.equal(orgB.status, 201);

  const tempPassword = "Acceptance-Temp-Password-14+";
  const finalPassword = "Acceptance-Final-Password-14+";
  async function createActiveMember(username, role, organizationId, membershipWindow = {}) {
    const user = await request("/api/users", {
      method: "POST",
      token: admin,
      body: { username, password: tempPassword, role },
    });
    assert.equal(user.status, 201, "create " + username);
    const mem = await request(`/api/organizations/${organizationId}/memberships`, {
      method: "POST",
      token: admin,
      body: { user_id: user.data.id, ...membershipWindow },
    });
    assert.equal(mem.status, 201, "membership " + username);
    const act = await request(`/api/organization-memberships/${mem.data.id}`, {
      method: "PATCH",
      token: admin,
      body: { status: "active" },
    });
    assert.equal(act.status, 200, "activate " + username);
    const loginTemp = await request("/api/auth/login", {
      method: "POST",
      body: { username, password: tempPassword },
    });
    assert.equal(loginTemp.status, 200, "temp login " + username);
    // New users must change temporary password before non-setup API access (not a relaxation of policy).
    const changed = await request("/api/auth/change-password", {
      method: "POST",
      token: loginTemp.data.token,
      body: { currentPassword: tempPassword, newPassword: finalPassword },
    });
    assert.equal(changed.status, 200, "password change " + username + " " + JSON.stringify(changed.data));
    const login = await request("/api/auth/login", {
      method: "POST",
      body: { username, password: finalPassword },
    });
    assert.equal(login.status, 200, "login " + username);
    return login.data.token;
  }

  const reviewerA = await createActiveMember("acc_reviewer_a", "reviewer", orgA.data.id);
  const reviewerB = await createActiveMember("acc_reviewer_b", "reviewer", orgB.data.id);
  const reviewerBNoGrant = await createActiveMember("acc_reviewer_b_no_grant", "reviewer", orgB.data.id);
  const reviewerExpired = await createActiveMember("acc_reviewer_expired", "reviewer", orgB.data.id);
  const forecasterA = await createActiveMember("acc_forecaster_a", "forecaster", orgA.data.id);
  const publisherA = await createActiveMember("acc_publisher_a", "publisher", orgA.data.id);
  const reviewerFuture = await createActiveMember(
    "acc_reviewer_future", "reviewer", orgA.data.id,
    { starts_at: new Date(Date.now() + 5 * 60 * 1000).toISOString() },
  );

  const sourceA = await request("/api/webhook-sources", {
    method: "POST",
    token: admin,
    body: {
      organization_id: orgA.data.id,
      source_key: "accept-source-a",
      label: "Acceptance Source A",
    },
  });
  assert.equal(sourceA.status, 201, "webhook source A");
  assert.ok(sourceA.data.secret && sourceA.data.secret.length >= 32);

  // W1: missing source header rejected
  const missingSource = await fetch(base + "/api/webhooks/inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Timestamp": String(Math.floor(Date.now() / 1000)),
      "X-Webhook-Signature": "00".repeat(32),
    },
    body: "{}",
  });
  assert.equal(missingSource.status, 401, "W1 missing X-Webhook-Source");

  // Ingest into org A
  const ts = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ msg: "acceptance-pack-a", n: 1 });
  const sig = createWebhookSignature(sourceA.data.secret, ts, body);
  const inbound = await fetch(base + "/api/webhooks/inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Timestamp": String(ts),
      "X-Webhook-Signature": sig,
      "X-Webhook-Source": "accept-source-a",
    },
    body,
  });
  assert.equal(inbound.status, 202, "org A webhook accepted");

  // W2: replay rejected
  const replay = await fetch(base + "/api/webhooks/inbound", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Webhook-Timestamp": String(ts),
      "X-Webhook-Signature": sig,
      "X-Webhook-Source": "accept-source-a",
    },
    body,
  });
  assert.equal(replay.status, 401, "W2 replay must be rejected");

  // I1: reviewer A sees inbox row; reviewer B does not
  const inboxA = await request("/api/webhooks/inbox", { token: reviewerA });
  assert.equal(inboxA.status, 200, "reviewer A inbox");
  const messagesA = inboxA.data.messages || [];
  assert.ok(messagesA.length >= 1, "reviewer A should see org A inbox rows");
  assert.ok(
    messagesA.every((m) => m.organization_id === orgA.data.id),
    "every inbox A row must carry organization_id of org A",
  );
  assert.ok(
    messagesA.some((m) => m.source_key === "accept-source-a"),
    "inbox A must include accept-source-a message",
  );

  const inboxB = await request("/api/webhooks/inbox", { token: reviewerB });
  assert.equal(inboxB.status, 200, "reviewer B inbox");
  const messagesB = inboxB.data.messages || [];
  assert.equal(messagesB.length, 0, "I1 reviewer B inbox must be empty when only org A was fed");
  assert.equal(
    messagesB.filter((m) => m.source_key === "accept-source-a" || m.organization_id === orgA.data.id).length,
    0,
    "I1 reviewer B must not see org A webhook inbox rows",
  );

  // Cross-tenant review attempt on org A message must be denied
  const targetId = messagesA[0].id;
  const crossReview = await request(`/api/webhooks/inbox/${targetId}/review`, {
    method: "PATCH",
    token: reviewerB,
    body: { status: "reviewed", note: "cross-tenant" },
  });
  assert.ok([403, 404].includes(crossReview.status), "I2 cross-tenant inbox review denied: " + crossReview.status);

  // A membership marked active but not yet started is not current authorization.
  const futureInbox = await request("/api/webhooks/inbox", { token: reviewerFuture });
  assert.equal(futureInbox.status, 403, "future-dated membership must not grant webhook inbox access");
  const futureReview = await request(`/api/webhooks/inbox/${targetId}/review`, {
    method: "PATCH",
    token: reviewerFuture,
    body: { status: "reviewed", note: "future-membership-must-not-authorize" },
  });
  assert.equal(futureReview.status, 403, "future-dated membership must not authorize webhook review");
  const stillPending = await request("/api/webhooks/inbox", { token: reviewerA });
  assert.equal(stillPending.data.messages.find((message) => message.id === targetId)?.status, "pending",
    "denied future-membership review must leave the inbox message pending");

  // Lifecycle slice: Public Test draft → submit → approve → publish
  const draft = await request("/api/alerts", {
    method: "POST",
    token: forecasterA,
    body: {
      event: "Acceptance Pack Test",
      headline: "Acceptance pack public test",
      description: "Isolated acceptance lifecycle slice",
      area_desc: "Test area",
      circle: "33.5,36.2 8",
      category: "Met",
      urgency: "Future",
      severity: "Minor",
      certainty: "Possible",
      status: "Test",
      scope: "Public",
    },
  });
  assert.equal(draft.status, 201, "L1 create draft");
  const alertId = draft.data.id || draft.data.alert?.id;
  assert.ok(alertId, "draft id");

  const submitted = await request(`/api/alerts/${alertId}/submit`, {
    method: "POST",
    token: forecasterA,
    body: {},
  });
  assert.ok([200, 201].includes(submitted.status), "L2 submit " + submitted.status);

  // Prefer reviewer approve path when available
  let approved = await request(`/api/alerts/${alertId}/approve`, {
    method: "POST",
    token: reviewerA,
    body: {},
  });
  if (approved.status >= 400) {
    approved = await request(`/api/alerts/${alertId}/approve`, {
      method: "POST",
      token: admin,
      body: {},
    });
  }
  assert.ok([200, 201].includes(approved.status), "approve path " + approved.status + " " + JSON.stringify(approved.data));

  const published = await request(`/api/alerts/${alertId}/publish`, {
    method: "POST",
    token: publisherA,
    body: {},
  });
  assert.ok([200, 201].includes(published.status), "L3 publish " + published.status + " " + JSON.stringify(published.data));

  const readBack = await request(`/api/alerts/${alertId}`, { token: publisherA });
  assert.equal(readBack.status, 200, "publisher can read published alert");
  const row = readBack.data.alert || readBack.data;
  assert.equal(row.workflow, "published", "workflow must be published after publish");
  assert.equal(row.status, "Test", "CAP status remains Test for acceptance slice");
  assert.equal(row.scope || "Public", "Public", "scope remains Public");

  // Audit authorization: identical-role recipient users differ only by an explicit active grant.
  const auditDb = new Database(path.join(cwd, "storage", "cap.sqlite"));
  let reviewerBId;
  let expiredReviewerId;
  let restrictedAlertId;
  try {
    reviewerBId = auditDb.prepare("SELECT id FROM users WHERE username=?").get("acc_reviewer_b").id;
    expiredReviewerId = auditDb.prepare("SELECT id FROM users WHERE username=?").get("acc_reviewer_expired").id;
    const insertRestricted = auditDb.prepare(`
      INSERT INTO alerts
        (identifier,sender,sent,status,msg_type,scope,restriction,addresses,event,category,
         urgency,severity,certainty,headline,description,area_desc,circle,workflow,references_text)
      VALUES (?,?,?,'Test','Alert',?,?,?,?,'Met','Expected','Moderate','Likely',?,?,?,?,?,?)
    `);
    restrictedAlertId = Number(insertRestricted.run(
      "restricted-audit-" + Date.now(), "audit-fixture@example.test", new Date().toISOString(),
      "Restricted", "Authorized recipients only", null, "Restricted audit event",
      "Restricted audit fixture headline", "RESTRICTED_AUDIT_DESCRIPTION", "Restricted test area",
      "33.5,36.2 8", "pending", ""
    ).lastInsertRowid);
    auditDb.prepare("UPDATE alerts SET polygon='' WHERE id=?").run(restrictedAlertId);
    auditDb.prepare(`UPDATE organization_memberships SET expires_at=?
      WHERE user_id=? AND organization_id=? AND status='active'`)
      .run(new Date(Date.now() - 60_000).toISOString(), expiredReviewerId, orgB.data.id);
    appendAuditLog(auditDb, {
      alertId: restrictedAlertId, action: "restricted_audit_fixture", details: "RESTRICTED_AUDIT_MARKER"
    });
    appendAuditLog(auditDb, { action: "platform_only_audit_probe", details: "must not appear in tenant audit views" });
  } finally { auditDb.close(); }

  const ownerAssigned = await request(`/api/alerts/${restrictedAlertId}/owner-organization`, {
    method: "POST", token: admin, body: { organization_id: orgA.data.id },
  });
  assert.equal(ownerAssigned.status, 200, "assign restricted alert owner");

  const grantCreated = await request(`/api/alerts/${restrictedAlertId}/grants`, {
    method: "POST", token: admin,
    body: {
      owner_organization_id: orgA.data.id, recipient_type: "user",
      recipient_user_id: reviewerBId, recipient_organization_id: orgB.data.id, action: "read",
    },
  });
  assert.equal(grantCreated.status, 201, "create direct audit-read grant");
  const grantActivated = await request(`/api/alert-recipient-grants/${grantCreated.data.id}`, {
    method: "PATCH", token: admin, body: { status: "active" },
  });
  assert.equal(grantActivated.status, 200, "activate direct audit-read grant");

  const authorizedAudit = await request(`/api/audit?organization_id=${orgB.data.id}`, { token: reviewerB });
  assert.equal(authorizedAudit.status, 200);
  assert.ok(authorizedAudit.data.entries.some(entry => entry.alert_id === restrictedAlertId),
    "valid direct recipient grant must expose linked audit events");

  const alertReadPaths = [
    `/api/alerts/${restrictedAlertId}`,
    `/api/alerts/${restrictedAlertId}/relations`,
    `/api/alerts/${restrictedAlertId}/review-history`,
    `/api/alerts/${restrictedAlertId}/versions`,
    `/api/alerts/${restrictedAlertId}/timeline`,
  ];
  for (const path of alertReadPaths) {
    assert.equal((await request(path + `?organization_id=${orgB.data.id}`, { token: reviewerB })).status, 200,
      "valid recipient grant must authorize " + path);
    for (const [label, token, organizationId] of [
      ["same-role peer without grant", reviewerBNoGrant, orgB.data.id],
      ["owner-side user without recipient grant", reviewerA, orgA.data.id],
      ["administrator without recipient grant", admin, undefined],
    ]) {
      const suffix = organizationId ? `?organization_id=${organizationId}` : "";
      assert.equal((await request(path + suffix, { token })).status, 404,
        label + " must not read " + path);
    }
  }
  const authorizedXml = await fetch(base + `/api/alerts/${restrictedAlertId}/cap.xml?organization_id=${orgB.data.id}`, {
    headers: { Authorization: "Bearer " + reviewerB },
  });
  const authorizedXmlBody = await authorizedXml.text();
  assert.equal(authorizedXml.status, 200, "valid grant must authorize CAP XML read: " + authorizedXmlBody);
  const deniedXml = await fetch(base + `/api/alerts/${restrictedAlertId}/cap.xml?organization_id=${orgA.data.id}`, {
    headers: { Authorization: "Bearer " + reviewerA },
  });
  assert.equal(deniedXml.status, 404, "missing grant must conceal CAP XML");
  assert.equal((await request(`/api/alerts/${restrictedAlertId}/review-notes?organization_id=${orgB.data.id}`, {
    method: "POST", token: reviewerB, body: { note: "read grant is not review permission" },
  })).status, 404, "read grant must not authorize review-note mutation");

  for (const [label, token, organizationId] of [
    ["same-role peer without grant", reviewerBNoGrant, orgB.data.id],
    ["alert owner organization without recipient grant", reviewerA, orgA.data.id],
    ["expired membership", reviewerExpired, orgB.data.id],
    ["future membership", reviewerFuture, orgA.data.id],
    ["administrator without recipient grant", admin, undefined],
  ]) {
    const suffix = organizationId ? `?organization_id=${organizationId}` : "";
    const listing = await request("/api/audit" + suffix, { token });
    assert.equal(listing.status, 200, label + " audit list");
    assert.equal(listing.data.entries.some(entry => entry.alert_id === restrictedAlertId), false,
      label + " must not see restricted alert-linked audit events");
    const isPlatformAdmin = label === "administrator without recipient grant";
    assert.equal(listing.data.entries.some(entry => entry.details === "must not appear in tenant audit views"), isPlatformAdmin,
      label + " platform-only audit visibility must follow the platform administrator boundary");
    const csvResponse = await fetch(base + "/api/audit/export.csv" + suffix, {
      headers: { Authorization: "Bearer " + token },
    });
    assert.equal(csvResponse.status, 200, label + " audit CSV export");
    const csv = await csvResponse.text();
    assert.equal(csv.split("\r\n").some(line => line.split(",")[3] === String(restrictedAlertId)), false,
      label + " CSV must not disclose restricted alert-linked audit rows");
    assert.equal(csv.includes("must not appear in tenant audit views"), isPlatformAdmin,
      label + " CSV platform-only events must follow the platform administrator boundary");
  }
  const authorizedCsvResponse = await fetch(base + `/api/audit/export.csv?organization_id=${orgB.data.id}`, {
    headers: { Authorization: "Bearer " + reviewerB },
  });
  assert.equal(authorizedCsvResponse.status, 200);
  const authorizedCsv = await authorizedCsvResponse.text();
  assert.ok(authorizedCsv.split("\r\n").some(line => line.split(",")[3] === String(restrictedAlertId)),
    "authorized CSV export must include granted alert-linked audit rows");
  assert.equal((await request("/api/audit/verify", { token: reviewerB })).status, 200,
    "reviewers may inspect chain-integrity metadata without receiving alert-linked event rows");
  assert.equal((await request("/api/audit/verify", { token: admin })).status, 200,
    "platform administrator can verify chain integrity without event-read bypass");

  // Public feed must not list Test messages as operational Actual
  const publicFeed = await request("/api/public/alerts");
  assert.equal(publicFeed.status, 200);
  const publicRows = publicFeed.data.alerts || publicFeed.data.messages || publicFeed.data || [];
  const listed = (Array.isArray(publicRows) ? publicRows : []).filter(
    (m) => m.id === alertId || m.identifier === row.identifier,
  );
  assert.equal(listed.length, 0, "Test alerts must not appear on public Actual feed");
});
