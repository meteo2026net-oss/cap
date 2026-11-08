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

test("delivery API enforces current deliver grants across two publisher tenants", { timeout: 120000 }, async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), "meteo-cap-delivery-auth-"));
  const dbPath = path.join(cwd, "cap.sqlite");
  const port = await reservePort();
  const base = "http://127.0.0.1:" + port;
  const adminPassword = "Delivery-Auth-Admin-Password-2026!";
  const child = spawn(process.execPath, [serverEntry], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DB_PATH: dbPath,
      JWT_SECRET: "delivery-auth-test-secret-at-least-32-characters-long",
      ADMIN_PASSWORD: adminPassword,
      MFA_ENCRYPTION_KEY: "f".repeat(64),
      MFA_REQUIRED_ROLES: "",
      CAP_NON_PUBLIC_RECIPIENT_ACCESS_ENABLED: "true",
      API_RATE_LIMIT: "5000",
      ADMIN_ACCOUNT_MUTATION_LIMIT: "1000"
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
  assert.equal(ready, true, "delivery authorization test server should become ready");

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
    return { status: response.status, data: await response.json().catch(() => ({})) };
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

  const createOrganization = async slug => {
    const result = await request("/api/organizations", {
      token: admin, method: "POST", body: { slug, name: slug.toUpperCase() }
    });
    assert.equal(result.status, 201);
    return result.data.id;
  };
  const orgA = await createOrganization("delivery-tenant-a");
  const orgB = await createOrganization("delivery-tenant-b");

  const temporaryPassword = "Delivery-User-Temporary-2026!";
  const finalPassword = "Delivery-User-Final-Password-2026!";
  const createUser = async (username, role) => {
    const created = await request("/api/users", {
      token: admin, method: "POST",
      body: { username, password: temporaryPassword, role }
    });
    assert.equal(created.status, 201, "user creation should succeed for " + username);
    const firstSession = await login(username, temporaryPassword);
    return { id: created.data.id, token: await changePassword(firstSession, temporaryPassword, finalPassword) };
  };
  const forecasterA = await createUser("delivery_forecaster_a", "forecaster");
  const publisherA = await createUser("delivery_publisher_a", "publisher");
  const publisherB = await createUser("delivery_publisher_b", "publisher");

  const addMembership = async (organizationId, userId) => {
    const result = await request(`/api/organizations/${organizationId}/memberships`, {
      token: admin, method: "POST", body: { user_id: userId }
    });
    assert.equal(result.status, 201);
    const activated = await request(`/api/organization-memberships/${result.data.id}`, {
      token: admin, method: "PATCH", body: { status: "active" }
    });
    assert.equal(activated.status, 200);
  };
  await addMembership(orgA, forecasterA.id);
  await addMembership(orgA, publisherA.id);
  await addMembership(orgB, publisherB.id);

  const alert = await request("/api/alerts", {
    token: forecasterA.token, method: "POST",
    body: {
      event: "Delivery authorization fixture",
      headline: "Synthetic tenant delivery test",
      description: "Isolated integration-test record",
      area_desc: "Test area",
      circle: "33.1,36.1 6",
      status: "Actual",
      scope: "Public",
      urgency: "Expected",
      severity: "Moderate",
      certainty: "Likely"
    }
  });
  assert.equal(alert.status, 201);
  assert.equal((await request(`/api/alerts/${alert.data.id}/owner-organization`, {
    token: admin, method: "POST", body: { organization_id: orgA }
  })).status, 200);

  const grant = await request(`/api/alerts/${alert.data.id}/grants`, {
    token: admin, method: "POST",
    body: {
      owner_organization_id: orgA,
      recipient_type: "user",
      recipient_user_id: publisherB.id,
      recipient_organization_id: orgB,
      action: "deliver"
    }
  });
  assert.equal(grant.status, 201);
  assert.equal((await request(`/api/alert-recipient-grants/${grant.data.id}`, {
    token: admin, method: "PATCH", body: { status: "active" }
  })).status, 200);

  let deliveryId;
  const fixtureDb = new Database(dbPath);
  try {
    fixtureDb.pragma("foreign_keys = ON");
    fixtureDb.prepare("UPDATE alerts SET scope='Restricted',restriction='authorized test recipient' WHERE id=?").run(alert.data.id);
    const inserted = fixtureDb.prepare(
      "INSERT INTO delivery_outbox(alert_id,channel,payload,status) VALUES(?,?,?,'queued')"
    ).run(alert.data.id, "cap_feed", "<synthetic-delivery/>");
    deliveryId = Number(inserted.lastInsertRowid);
  } finally {
    fixtureDb.close();
  }

  const listB = await request("/api/delivery/outbox", {
    token: publisherB.token, organizationId: orgB
  });
  assert.equal(listB.status, 200);
  assert.deepEqual(listB.data.deliveries.map(row => row.id), [deliveryId],
    "a current deliver grant exposes the recipient's outbox row");

  const listA = await request("/api/delivery/outbox", {
    token: publisherA.token, organizationId: orgA
  });
  assert.equal(listA.status, 200);
  assert.deepEqual(listA.data.deliveries, [],
    "a same-role publisher in the owning tenant cannot enumerate the recipient's delivery");
  assert.equal(listA.data.counts.queued, 0);

  const adminList = await request("/api/delivery/outbox", { token: admin });
  assert.equal(adminList.status, 200);
  assert.deepEqual(adminList.data.deliveries, [],
    "platform admin does not implicitly receive an alert-linked deliver grant");

  const claimPath = `/api/delivery/outbox/${deliveryId}/claim`;
  const deniedClaim = await request(claimPath, {
    token: publisherA.token, method: "POST", organizationId: orgA
  });
  assert.equal(deniedClaim.status, 404,
    "a same-role user without a recipient grant receives a concealed not-found response");

  const claimed = await request(claimPath, {
    token: publisherB.token, method: "POST", organizationId: orgB
  });
  assert.equal(claimed.status, 200);
  assert.ok(claimed.data.delivery.lease_token);
  assert.equal(claimed.data.external_adapters_enabled, false);

  const deniedReceipt = await request(`/api/delivery/outbox/${deliveryId}/receipt`, {
    token: publisherA.token, method: "POST", organizationId: orgA,
    body: { status: "delivered", leaseToken: claimed.data.delivery.lease_token }
  });
  assert.equal(deniedReceipt.status, 404,
    "a same-role user cannot record a receipt against another tenant's delivery");

  const failedReceipt = await request(`/api/delivery/outbox/${deliveryId}/receipt`, {
    token: publisherB.token, method: "POST", organizationId: orgB,
    body: { status: "failed", leaseToken: claimed.data.delivery.lease_token, details: "synthetic retry test" }
  });
  assert.equal(failedReceipt.status, 200);

  const deniedRetry = await request(`/api/delivery/outbox/${deliveryId}/retry`, {
    token: publisherA.token, method: "POST", organizationId: orgA
  });
  assert.equal(deniedRetry.status, 404);

  const retried = await request(`/api/delivery/outbox/${deliveryId}/retry`, {
    token: publisherB.token, method: "POST", organizationId: orgB
  });
  assert.equal(retried.status, 200);

  const secondClaim = await request(claimPath, {
    token: publisherB.token, method: "POST", organizationId: orgB
  });
  assert.equal(secondClaim.status, 200);
  const deliveredReceipt = await request(`/api/delivery/outbox/${deliveryId}/receipt`, {
    token: publisherB.token, method: "POST", organizationId: orgB,
    body: { status: "delivered", leaseToken: secondClaim.data.delivery.lease_token, externalId: "synthetic-local-id" }
  });
  assert.equal(deliveredReceipt.status, 200);
  assert.equal(deliveredReceipt.data.delivery.status, "delivered");
});
