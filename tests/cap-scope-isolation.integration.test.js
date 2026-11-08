import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  await new Promise(resolve => server.close(resolve));
  return port;
}

test("Restricted and Private legacy alerts are denied across authenticated and public API surfaces", { timeout: 90000 }, async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), "meteo-cap-isolation-"));
  const port = await reservePort();
  const base = "http://127.0.0.1:" + port;
  const adminPassword = "Isolation-Test-Admin-Password-2026!";
  const child = spawn(process.execPath, [serverEntry], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      JWT_SECRET: "isolation-test-secret-that-is-at-least-32-characters",
      ADMIN_PASSWORD: adminPassword,
      CAP_DELIVERY_ENABLED: "true",
      MFA_ENCRYPTION_KEY: "c".repeat(64),
      MFA_REQUIRED_ROLES: "",
      API_RATE_LIMIT: "5000",
      CAP_SENDER: "isolation@example.test"
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
  assert.equal(ready, true, "isolation API server should become ready");

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
    assert.equal(result.status, 200, "login should succeed for " + username);
    return result.data.token;
  };
  const changePassword = async (token, currentPassword, newPassword) => {
    const changed = await request("/api/auth/change-password", {
      token, method: "POST", body: { currentPassword, newPassword }
    });
    assert.equal(changed.status, 200, "password change should succeed");
    return changed.data.token;
  };

  let admin = await login("admin", adminPassword);
  admin = await changePassword(admin, adminPassword, adminPassword + "X");
  const tempPassword = "Isolation-Role-Password-2026!";
  const finalPassword = "Isolation-Role-Password-Final-2026!";
  for (const [username, role] of [
    ["iso_forecaster", "forecaster"],
    ["iso_forecaster_b", "forecaster"],
    ["iso_reviewer", "reviewer"],
    ["iso_reviewer_b", "reviewer"],
    ["iso_publisher", "publisher"],
    ["iso_publisher_b", "publisher"]
  ]) {
    assert.equal((await request("/api/users", {
      token: admin, method: "POST", body: { username, password: tempPassword, role }
    })).status, 201);
  }
  const activate = async username => changePassword(await login(username, tempPassword), tempPassword, finalPassword);
  const forecaster = await activate("iso_forecaster");
  const forecasterB = await activate("iso_forecaster_b");
  const reviewer = await activate("iso_reviewer");
  const reviewerB = await activate("iso_reviewer_b");
  const publisher = await activate("iso_publisher");
  const publisherB = await activate("iso_publisher_b");

  const organizationA = await request("/api/organizations", {
    token: admin, method: "POST", body: { slug: "isolation-org-a", name: "Isolation Organization A" }
  });
  const organizationB = await request("/api/organizations", {
    token: admin, method: "POST", body: { slug: "isolation-org-b", name: "Isolation Organization B" }
  });
  assert.equal(organizationA.status, 201);
  assert.equal(organizationB.status, 201);
  const accountRows = (await request("/api/users", { token: admin })).data.users;
  const tenantMemberships = [];
  for (const [organizationId, username] of [
    [organizationA.data.id, "iso_forecaster"],
    [organizationA.data.id, "iso_reviewer"],
    [organizationA.data.id, "iso_publisher"],
    [organizationB.data.id, "iso_forecaster_b"],
    [organizationB.data.id, "iso_reviewer_b"],
    [organizationB.data.id, "iso_publisher_b"]
  ]) {
    const userId = accountRows.find(row => row.username === username).id;
    const membership = await request(`/api/organizations/${organizationId}/memberships`, {
      token: admin, method: "POST", body: { user_id: userId }
    });
    assert.equal(membership.status, 201, username + " membership should be created");
    assert.equal((await request(`/api/organization-memberships/${membership.data.id}`, {
      token: admin, method: "PATCH", body: { status: "active" }
    })).status, 200, username + " membership should be activated");
    tenantMemberships.push(membership.data);
  }

  assert.equal((await request("/api/webhooks/inbox", { token: reviewerB })).status, 403,
    "reviewer access to the global webhook inbox is disabled once organizations exist without source attribution");
  const webhookDenied = await request("/api/webhooks/inbox", { token: reviewerB });
  assert.equal(webhookDenied.data.code, "WEBHOOK_TENANT_ATTRIBUTION_UNCONFIGURED");
  const webhookReviewDenied = await request("/api/webhooks/inbox/999/review", {
    token: reviewerB, method: "PATCH", body: { status: "reviewed", note: "cross-tenant attempt" }
  });
  assert.equal(webhookReviewDenied.status, 403,
    "review mutations are blocked along with global inbox enumeration");
  assert.equal((await request("/api/webhooks/inbox", { token: admin })).status, 200,
    "platform administrators retain the global inbox for controlled triage");
  const adminAudit = await request("/api/audit?limit=500", { token: admin });
  assert.ok((adminAudit.data.entries || []).some(entry =>
    entry.action === "organization_created" && entry.details.includes("isolation-org-a")),
    "platform administrators retain global audit visibility");
  const scopedAudit = await request("/api/audit?limit=500", { token: reviewerB });
  assert.equal(scopedAudit.status, 200);
  assert.ok(!(scopedAudit.data.entries || []).some(entry =>
    entry.action === "organization_created" || entry.action.startsWith("organization_membership_")),
    "non-admin audit readers cannot enumerate alert-less organization lifecycle events");
  const scopedAuditCsv = await fetch(base + "/api/audit/export.csv", {
    headers: { Authorization: "Bearer " + reviewerB }
  });
  const scopedAuditCsvText = await scopedAuditCsv.text();
  assert.equal(scopedAuditCsv.status, 200);
  assert.doesNotMatch(scopedAuditCsvText, /isolation-org-a|isolation-org-b/);

  const publicCreate = await request("/api/alerts", {
    token: forecaster, method: "POST", body: {
      event: "Isolation public", headline: "Isolation public headline unique-public-xyz",
      description: "Public isolation fixture", area_desc: "Isolation public area",
      circle: "33.1,36.1 6", status: "Actual", scope: "Public",
      urgency: "Expected", severity: "Moderate", certainty: "Likely"
    }
  });
  assert.equal(publicCreate.status, 201);
  const publicId = publicCreate.data.id;
  assert.equal((await request(`/api/alerts/${publicId}/owner-organization`, {
    token: admin, method: "POST", body: { organization_id: organizationA.data.id }
  })).status, 200);
  assert.equal((await request(`/api/alerts/${publicId}`, { token: forecasterB })).status, 200,
    "Public alerts remain globally readable by the same role across organizations by explicit policy");
  const publicListB = await request("/api/alerts?q=unique-public-xyz", { token: forecasterB });
  assert.equal(publicListB.status, 200);
  assert.ok((publicListB.data.alerts || []).some(row => row.id === publicId),
    "same-role Organization B user sees only the explicitly global Public alert, not a tenant-scoped secret");
  assert.equal((await request(`/api/alerts/${publicId}/submit`, { token: forecaster, method: "POST", body: {} })).status, 200);
  assert.equal((await request(`/api/alerts/${publicId}/approve`, { token: reviewer, method: "POST", body: {} })).status, 200);
  assert.equal((await request(`/api/alerts/${publicId}/publish`, { token: publisher, method: "POST", body: {} })).status, 200);

  // Insert legacy records directly to model data created before the Public-only API gate.
  const db = new Database(path.join(cwd, "storage", "cap.sqlite"));
  const insert = db.prepare(`INSERT INTO alerts
    (identifier,sender,sent,status,msg_type,scope,restriction,addresses,event,category,urgency,severity,certainty,headline,description,area_desc,workflow,references_text)
    VALUES (?,?,?,'Test','Alert',?,?,?,?,'Met','Expected','Moderate','Likely',?,?,?, ?,?)`);
  const restrictedId = Number(insert.run(
    "legacy-restricted-" + Date.now(), "legacy@example.test", "2026-11-07T00:00:00.000Z",
    "Restricted", "Authorized agencies only", null, "Restricted event", "unique-restricted-xyz",
    "RESTRICTED_SECRET_DESCRIPTION", "Restricted zone", "pending", ""
  ).lastInsertRowid);
  const privateId = Number(insert.run(
    "legacy-private-" + Date.now(), "legacy@example.test", "2026-11-07T00:01:00.000Z",
    "Private", null, "ops@example.test duty@example.test", "Private event", "unique-private-xyz",
    "PRIVATE_SECRET_DESCRIPTION", "Private zone", "pending", ""
  ).lastInsertRowid);
  db.prepare("UPDATE alerts SET owner_organization_id=? WHERE id IN (?,?)")
    .run(organizationA.data.id, restrictedId, privateId);
  appendAuditLog(db, { userId: null, alertId: privateId, action: "private_scope_fixture", details: "PRIVATE_AUDIT_SECRET" });
  const deliveryId = Number(db.prepare("INSERT INTO delivery_outbox(alert_id,channel,payload,status) VALUES(?,'cap_feed','PRIVATE_DELIVERY_SECRET','queued')")
    .run(privateId).lastInsertRowid);
  db.close();

  const sensitiveNeedles = [
    "unique-restricted-xyz", "unique-private-xyz", "RESTRICTED_SECRET_DESCRIPTION",
    "PRIVATE_SECRET_DESCRIPTION", "Authorized agencies only", "ops@example.test",
    "PRIVATE_AUDIT_SECRET", "PRIVATE_DELIVERY_SECRET"
  ];

  // All internal endpoints still require authentication.
  for (const url of [
    "/api/alerts", "/api/alerts?q=unique-restricted-xyz", "/api/alerts?scope=Restricted",
    "/api/alerts/export.csv", "/api/alerts/stats", `/api/alerts/${restrictedId}`,
    `/api/alerts/${privateId}/cap.xml`, `/api/alerts/${privateId}/relations`,
    `/api/alerts/${privateId}/versions`, `/api/alerts/${privateId}/timeline`,
    "/api/review/queue", "/api/audit", "/api/delivery/outbox"
  ]) {
    const response = await fetch(base + url);
    assert.equal(response.status, 401, `${url} must require authentication`);
    const body = await response.text();
    for (const needle of sensitiveNeedles) assert.ok(!body.includes(needle), `${url} leaked ${needle}`);
  }

  const restrictedCreate = await request("/api/alerts", {
    token: forecaster, method: "POST", body: {
      event: "Restricted create", headline: "Restricted create",
      description: "Restricted create", area_desc: "Restricted area",
      circle: "33.2,36.2 5", scope: "Restricted", restriction: "Authorized agencies only"
    }
  });
  assert.equal(restrictedCreate.status, 403);
  assert.equal(restrictedCreate.data.code, "SCOPE_AUTHORIZATION_UNCONFIGURED");
  const privateCreate = await request("/api/alerts/", {
    token: forecaster, method: "POST", body: {
      event: "Private create", headline: "Private create",
      description: "Private create", area_desc: "Private area",
      circle: "33.3,36.3 5", scope: "Private", addresses: "ops@example.test"
    }
  });
  assert.equal(privateCreate.status, 403, "trailing slash must not bypass the Private create guard");

  assert.equal((await request("/api/alerts?scope=Restricted", { token: forecaster })).status, 403);
  assert.equal((await request("/api/alerts?scope=Private", { token: forecaster })).status, 403);
  const list = await request("/api/alerts?q=unique-restricted-xyz", { token: forecaster });
  assert.equal(list.status, 200);
  assert.ok(!(list.data.alerts || []).some(alert => alert.id === restrictedId || alert.id === privateId));
  for (const id of [restrictedId, privateId]) {
    assert.equal((await request(`/api/alerts/${id}`, { token: forecaster })).status, 404);
    assert.equal((await request(`/api/alerts/${id}`, { token: forecasterB })).status, 404,
      "same-role user in Organization B cannot read Organization A non-Public alert by direct ID");
    assert.equal((await request(`/api/alerts/0${id}`, { token: forecasterB })).status, 404,
      "padded direct-ID aliases do not bypass cross-organization concealment");
    assert.equal((await request(`/api/alerts/${id}/relations`, { token: forecasterB })).status, 404);
    assert.equal((await request(`/api/alerts/0${id}`, { token: forecaster })).status, 404);
    assert.equal((await request(`/api/alerts/${id}/cap.xml`, { token: forecaster })).status, 404);
    assert.equal((await request(`/api/alerts/${id}/cap.xml`, { token: forecasterB })).status, 404);
    assert.equal((await request(`/api/alerts/${id}/relations`, { token: forecaster })).status, 404);
    assert.equal((await request(`/api/alerts/${id}/versions`, { token: reviewer })).status, 404);
    assert.equal((await request(`/api/alerts/${id}/versions`, { token: reviewerB })).status, 404);
    assert.equal((await request(`/api/alerts/${id}/timeline`, { token: reviewer })).status, 404);
    assert.equal((await request(`/api/alerts/${id}/timeline`, { token: reviewerB })).status, 404);
  }

  const exportResponse = await fetch(base + "/api/alerts/export.csv", {
    headers: { Authorization: "Bearer " + forecasterB }
  });
  const exportText = await exportResponse.text();
  assert.equal(exportResponse.status, 200);
  for (const needle of sensitiveNeedles) assert.ok(!exportText.includes(needle), "CSV export leaked " + needle);

  const reviewQueue = await request("/api/review/queue", { token: reviewerB });
  assert.equal(reviewQueue.status, 200);
  assert.ok(!(reviewQueue.data.queue || []).some(row => row.id === restrictedId || row.id === privateId));
  assert.ok(!JSON.stringify(reviewQueue.data).includes("Authorized agencies only"));
  assert.ok(!JSON.stringify(reviewQueue.data).includes("ops@example.test"));

  const audit = await request("/api/audit?limit=500", { token: reviewerB });
  assert.equal(audit.status, 200);
  assert.ok(!JSON.stringify(audit.data).includes("PRIVATE_AUDIT_SECRET"));
  const auditCsv = await fetch(base + "/api/audit/export.csv", {
    headers: { Authorization: "Bearer " + reviewerB }
  });
  const auditCsvText = await auditCsv.text();
  assert.ok(!auditCsvText.includes("PRIVATE_AUDIT_SECRET"));

  const outbox = await request("/api/delivery/outbox", { token: publisherB });
  assert.equal(outbox.status, 200);
  assert.ok(!(outbox.data.deliveries || []).some(row => row.id === deliveryId));
  assert.equal((await request(`/api/delivery/outbox/${deliveryId}/claim`, {
    token: publisherB, method: "POST"
  })).status, 404);
  assert.equal((await request(`/api/delivery/outbox/${deliveryId}/retry`, {
    token: publisherB, method: "POST"
  })).status, 404, "non-Public outbox entries must not be manually retried");
  assert.equal((await request(`/api/delivery/outbox/${deliveryId}/receipt`, {
    token: publisherB, method: "POST",
    body: { status: "delivered", leaseToken: "123e4567-e89b-42d3-a456-426614174000" }
  })).status, 404, "non-Public outbox entries must not accept delivery receipts");
  assert.equal((await request("/api/delivery/process-retries", {
    token: publisherB, method: "POST"
  })).status, 403);
  assert.equal((await request("/api/delivery/recover-stale", {
    token: publisherB, method: "POST", body: { staleMinutes: 10 }
  })).status, 403, "global stale recovery remains blocked while legacy non-Public rows exist");

  const metrics = await request("/api/health/metrics", { token: publisherB });
  assert.equal(metrics.status, 200);
  assert.equal(metrics.data.metrics.alerts_by_workflow.pending || 0, 0,
    "metrics must not reveal legacy Restricted/Private pending alerts");

  for (const url of ["/api/public/alerts", "/api/public/alerts.geojson"]) {
    const response = await fetch(base + url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.text();
    assert.ok(body.includes(publicCreate.data.identifier));
    for (const needle of sensitiveNeedles) assert.ok(!body.includes(needle), `${url} leaked ${needle}`);
    if (url.endsWith("/alerts")) {
      const data = JSON.parse(body);
      assert.ok((data.alerts || []).every(alert => alert.scope === "Public"));
      assert.ok((data.alerts || []).every(alert => alert.status === "Actual"));
    }
  }
});
