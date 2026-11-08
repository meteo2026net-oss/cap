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

test("opt-in recipient grants isolate same-role alert reads, exports and delivery operations", { timeout: 90000 }, async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cap-recipient-grants-"));
  const port = await reservePort();
  const base = "http://127.0.0.1:" + port;
  const adminPassword = "Recipient-Grant-Admin-Password-2026!";
  const child = spawn(process.execPath, [serverEntry], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      JWT_SECRET: "recipient-grant-test-secret-that-is-at-least-32-characters",
      ADMIN_PASSWORD: adminPassword,
      CAP_DELIVERY_ENABLED: "true",
      CAP_NON_PUBLIC_RECIPIENT_ACCESS_ENABLED: "true",
      MFA_ENCRYPTION_KEY: "d".repeat(64),
      MFA_REQUIRED_ROLES: "",
      API_RATE_LIMIT: "5000",
      CAP_SENDER: "recipient-grants@example.test"
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
      if ((await fetch(base + "/api/health")).ok) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, "grant enforcement API should become ready");

  const request = async (url, { token, method = "GET", body, organizationId } = {}) => {
    const response = await fetch(base + url, {
      method,
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(organizationId ? { "X-CAP-Organization-ID": String(organizationId) } : {}),
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const text = await response.text();
    let data = {};
    try { data = JSON.parse(text); } catch {}
    return { status: response.status, data, text, response };
  };
  const login = async (username, password) => {
    const result = await request("/api/auth/login", { method: "POST", body: { username, password } });
    assert.equal(result.status, 200, "login should succeed for " + username);
    return result.data.token;
  };
  const changePassword = async (token, currentPassword, newPassword) => {
    const result = await request("/api/auth/change-password", {
      token, method: "POST", body: { currentPassword, newPassword }
    });
    assert.equal(result.status, 200, "password change should succeed");
    return result.data.token;
  };

  let admin = await login("admin", adminPassword);
  admin = await changePassword(admin, adminPassword, adminPassword + "X");
  const temporary = "Recipient-Role-Password-2026!";
  const final = "Recipient-Role-Password-Final-2026!";
  for (const [username, role] of [
    ["grant_forecaster_a", "forecaster"],
    ["grant_forecaster_b", "forecaster"],
    ["grant_publisher_a", "publisher"],
    ["grant_publisher_b", "publisher"]
  ]) {
    assert.equal((await request("/api/users", {
      token: admin, method: "POST", body: { username, password: temporary, role }
    })).status, 201);
  }
  const activate = async username => changePassword(await login(username, temporary), temporary, final);
  const forecasterA = await activate("grant_forecaster_a");
  const forecasterB = await activate("grant_forecaster_b");
  const publisherA = await activate("grant_publisher_a");
  const publisherB = await activate("grant_publisher_b");

  const orgA = await request("/api/organizations", {
    token: admin, method: "POST", body: { slug: "grant-owner-a", name: "Grant Owner A" }
  });
  const orgB = await request("/api/organizations", {
    token: admin, method: "POST", body: { slug: "grant-recipient-b", name: "Grant Recipient B" }
  });
  assert.equal(orgA.status, 201);
  assert.equal(orgB.status, 201);
  const users = (await request("/api/users", { token: admin })).data.users;
  for (const [org, username] of [
    [orgA.data.id, "grant_forecaster_a"],
    [orgA.data.id, "grant_publisher_a"],
    [orgB.data.id, "grant_forecaster_b"],
    [orgB.data.id, "grant_publisher_b"]
  ]) {
    const user = users.find(row => row.username === username);
    const membership = await request(`/api/organizations/${org}/memberships`, {
      token: admin, method: "POST", body: { user_id: user.id }
    });
    assert.equal(membership.status, 201);
    assert.equal((await request(`/api/organization-memberships/${membership.data.id}`, {
      token: admin, method: "PATCH", body: { status: "active" }
    })).status, 200);
  }

  const created = await request("/api/alerts", {
    token: forecasterA, method: "POST", body: {
      event: "Grant-protected event",
      headline: "TENANT_B_ONLY_HEADLINE",
      description: "TENANT_B_ONLY_DESCRIPTION",
      area_desc: "Grant test area",
      circle: "33.1,36.1 6",
      status: "Actual",
      scope: "Public",
      urgency: "Expected",
      severity: "Moderate",
      certainty: "Likely"
    }
  });
  assert.equal(created.status, 201);
  const alertId = created.data.id;
  assert.equal((await request(`/api/alerts/${alertId}/owner-organization`, {
    token: admin, method: "POST", body: { organization_id: orgA.data.id }
  })).status, 200);

  const readGrant = await request(`/api/alerts/${alertId}/grants`, {
    token: admin, method: "POST", body: {
      owner_organization_id: orgA.data.id,
      recipient_type: "organization",
      recipient_organization_id: orgB.data.id,
      action: "read"
    }
  });
  assert.equal(readGrant.status, 201);
  assert.equal((await request(`/api/alert-recipient-grants/${readGrant.data.id}`, {
    token: admin, method: "PATCH", body: { status: "active" }
  })).status, 200);

  const deliverGrant = await request(`/api/alerts/${alertId}/grants`, {
    token: admin, method: "POST", body: {
      owner_organization_id: orgA.data.id,
      recipient_type: "organization",
      recipient_organization_id: orgB.data.id,
      action: "deliver"
    }
  });
  assert.equal(deliverGrant.status, 201);
  assert.equal((await request(`/api/alert-recipient-grants/${deliverGrant.data.id}`, {
    token: admin, method: "PATCH", body: { status: "active" }
  })).status, 200);

  const db = new Database(path.join(cwd, "storage", "cap.sqlite"));
  db.prepare("UPDATE alerts SET scope='Restricted' WHERE id=?").run(alertId);
  const deliveryId = Number(db.prepare(
    "INSERT INTO delivery_outbox(alert_id,channel,payload,status) VALUES(?,'cap_feed','TENANT_B_DELIVERY_PAYLOAD','queued')"
  ).run(alertId).lastInsertRowid);
  db.close();

  const adminGrantList = await request(`/api/alerts/${alertId}/grants`, { token: admin });
  assert.equal(adminGrantList.status, 200, "platform Admin must retain grant management visibility after an alert becomes non-Public");

  const readB = await request(`/api/alerts/${alertId}`, { token: forecasterB, organizationId: orgB.data.id });
  assert.equal(readB.status, 200);
  assert.equal(readB.data.alert.headline, "TENANT_B_ONLY_HEADLINE");
  assert.equal((await request(`/api/alerts/${alertId}`, { token: forecasterB })).status, 404,
    "a valid grant is insufficient without an explicit active organization context");
  assert.equal((await request("/api/alerts?scope=Restricted", {
    token: forecasterA, organizationId: orgB.data.id
  })).status, 403, "a user cannot select an organization where they have no active membership");
  for (const result of [
    await request(`/api/alerts/${alertId}`, { token: forecasterA, organizationId: orgA.data.id }),
    await request(`/api/alerts/${alertId}/cap.xml`, { token: forecasterA, organizationId: orgA.data.id }),
    await request(`/api/alerts/${alertId}/relations`, { token: forecasterA, organizationId: orgA.data.id })
  ]) assert.equal(result.status, 404, "same-role owning-organization user must not read recipient-only alert surfaces");

  const listB = await request("/api/alerts?scope=Restricted", { token: forecasterB, organizationId: orgB.data.id });
  assert.equal(listB.status, 200);
  assert.ok(listB.data.alerts.some(row => row.id === alertId));
  const listA = await request("/api/alerts?scope=Restricted", { token: forecasterA, organizationId: orgA.data.id });
  assert.equal(listA.status, 200);
  assert.ok(!listA.data.alerts.some(row => row.id === alertId));
  const exportB = await request("/api/alerts/export.csv?scope=Restricted", { token: forecasterB, organizationId: orgB.data.id });
  const exportA = await request("/api/alerts/export.csv?scope=Restricted", { token: forecasterA, organizationId: orgA.data.id });
  assert.equal(exportB.status, 200);
  assert.match(exportB.text, /TENANT_B_ONLY_HEADLINE/);
  assert.equal(exportA.status, 200);
  assert.doesNotMatch(exportA.text, /TENANT_B_ONLY_HEADLINE/);
  assert.equal((await request(`/api/alert-recipient-grants/${readGrant.data.id}`, {
    token: admin, method: "PATCH", body: { status: "revoked" }
  })).status, 200);
  assert.equal((await request(`/api/alerts/${alertId}`, {
    token: forecasterB, organizationId: orgB.data.id
  })).status, 404, "revoking a read grant immediately removes detail access");
  const revokedListB = await request("/api/alerts?scope=Restricted", {
    token: forecasterB, organizationId: orgB.data.id
  });
  assert.ok(!revokedListB.data.alerts.some(row => row.id === alertId));
  const revokedExportB = await request("/api/alerts/export.csv?scope=Restricted", {
    token: forecasterB, organizationId: orgB.data.id
  });
  assert.doesNotMatch(revokedExportB.text, /TENANT_B_ONLY_HEADLINE/);

  const outboxB = await request("/api/delivery/outbox", { token: publisherB, organizationId: orgB.data.id });
  const outboxA = await request("/api/delivery/outbox", { token: publisherA, organizationId: orgA.data.id });
  assert.ok(outboxB.data.deliveries.some(row => row.id === deliveryId));
  assert.ok(!outboxA.data.deliveries.some(row => row.id === deliveryId));
  assert.equal((await request(`/api/delivery/outbox/${deliveryId}/claim`, {
    token: publisherA, method: "POST", organizationId: orgA.data.id
  })).status, 404);
  const claimB = await request(`/api/delivery/outbox/${deliveryId}/claim`, {
    token: publisherB, method: "POST", organizationId: orgB.data.id
  });
  assert.equal(claimB.status, 200);
  assert.equal((await request(`/api/delivery/outbox/${deliveryId}/receipt`, {
    token: publisherB, method: "POST", organizationId: orgB.data.id,
    body: { status: "failed", leaseToken: claimB.data.delivery.lease_token, details: "Synthetic failure" }
  })).status, 200);
  assert.equal((await request(`/api/delivery/outbox/${deliveryId}/retry`, {
    token: publisherA, method: "POST", organizationId: orgA.data.id
  })).status, 404);
  assert.equal((await request(`/api/delivery/outbox/${deliveryId}/retry`, {
    token: publisherB, method: "POST", organizationId: orgB.data.id
  })).status, 200);
  assert.equal((await request(`/api/alert-recipient-grants/${deliverGrant.data.id}`, {
    token: admin, method: "PATCH", body: { status: "revoked" }
  })).status, 200);
  const revokedOutboxB = await request("/api/delivery/outbox", {
    token: publisherB, organizationId: orgB.data.id
  });
  assert.ok(!revokedOutboxB.data.deliveries.some(row => row.id === deliveryId),
    "revoking a deliver grant immediately removes the outbox row from the recipient view");
  assert.equal((await request(`/api/delivery/outbox/${deliveryId}/claim`, {
    token: publisherB, method: "POST", organizationId: orgB.data.id
  })).status, 404);
});
