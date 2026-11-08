import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

test("organization membership API enforces admin control and same-role tenant membership isolation", { timeout: 90000 }, async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), "meteo-cap-recipient-api-"));
  const port = await reservePort();
  const base = "http://127.0.0.1:" + port;
  const adminPassword = "Recipient-API-Admin-Password-2026!";
  const child = spawn(process.execPath, [serverEntry], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      JWT_SECRET: "recipient-api-test-secret-at-least-32-characters-long",
      ADMIN_PASSWORD: adminPassword,
      MFA_ENCRYPTION_KEY: "d".repeat(64),
      MFA_REQUIRED_ROLES: "",
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
  assert.equal(ready, true, "recipient API server should become ready");

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
  const organizationA = await request("/api/organizations", {
    token: admin, method: "POST", body: { slug: "tenant-a", name: "Tenant A" }
  });
  const organizationB = await request("/api/organizations", {
    token: admin, method: "POST", body: { slug: "tenant-b", name: "Tenant B" }
  });
  assert.equal(organizationA.status, 201);
  assert.equal(organizationB.status, 201);
  assert.notEqual(organizationA.data.id, organizationB.data.id);
  assert.equal((await request("/api/organizations", { token: admin })).status, 200);
  assert.equal((await request("/api/organizations", { token: undefined })).status, 401);

  const temporaryPassword = "Recipient-User-Temporary-2026!";
  const finalPassword = "Recipient-User-Final-Password-2026!";
  const createForecaster = async username => {
    const created = await request("/api/users", {
      token: admin, method: "POST",
      body: { username, password: temporaryPassword, role: "forecaster" }
    });
    assert.equal(created.status, 201);
    const firstSession = await login(username, temporaryPassword);
    return changePassword(firstSession, temporaryPassword, finalPassword);
  };
  const forecasterA = await createForecaster("tenant_a_forecaster");
  const forecasterB = await createForecaster("tenant_b_forecaster");

  const membershipA = await request(`/api/organizations/${organizationA.data.id}/memberships`, {
    token: admin, method: "POST", body: { user_id: 2 }
  });
  const membershipB = await request(`/api/organizations/${organizationB.data.id}/memberships`, {
    token: admin, method: "POST", body: { user_id: 3 }
  });
  assert.equal(membershipA.status, 201);
  assert.equal(membershipB.status, 201);
  assert.equal(membershipA.data.status, "pending");
  assert.equal(membershipB.data.status, "pending");

  assert.equal((await request(`/api/organization-memberships/${membershipA.data.id}`, {
    token: admin, method: "PATCH", body: { status: "active" }
  })).status, 200);
  assert.equal((await request(`/api/organization-memberships/${membershipB.data.id}`, {
    token: admin, method: "PATCH", body: { status: "active" }
  })).status, 200);

  const listA = await request(`/api/organizations/${organizationA.data.id}/memberships`, { token: admin });
  const listB = await request(`/api/organizations/${organizationB.data.id}/memberships`, { token: admin });
  assert.equal(listA.status, 200);
  assert.equal(listB.status, 200);
  assert.deepEqual(listA.data.memberships.map(row => row.username), ["tenant_a_forecaster"]);
  assert.deepEqual(listB.data.memberships.map(row => row.username), ["tenant_b_forecaster"]);
  assert.equal((await request(`/api/organizations/${organizationA.data.id}/memberships`, {
    token: forecasterB
  })).status, 403, "same-role users cannot enumerate organization membership administration");
  assert.equal((await request("/api/organizations", { token: forecasterA })).status, 403);

  const groupA = await request(`/api/organizations/${organizationA.data.id}/groups`, {
    token: admin, method: "POST", body: { slug: "operations", name: "Operations" }
  });
  const groupB = await request(`/api/organizations/${organizationB.data.id}/groups`, {
    token: admin, method: "POST", body: { slug: "operations", name: "Operations" }
  });
  assert.equal(groupA.status, 201);
  assert.equal(groupB.status, 201);
  assert.notEqual(groupA.data.id, groupB.data.id,
    "same group slug may exist in separate organizations without sharing identity");
  assert.equal((await request(`/api/recipient-groups/${groupA.data.id}/memberships`, {
    token: admin, method: "POST",
    body: { organization_membership_id: membershipB.data.id }
  })).status, 404, "a group cannot accept a member from another organization");
  const groupMembershipA = await request(`/api/recipient-groups/${groupA.data.id}/memberships`, {
    token: admin, method: "POST",
    body: { organization_membership_id: membershipA.data.id }
  });
  assert.equal(groupMembershipA.status, 201);
  assert.equal((await request(`/api/recipient-group-memberships/${groupMembershipA.data.id}`, {
    token: admin, method: "PATCH", body: { status: "active" }
  })).status, 200);
  const groupMembersA = await request(`/api/recipient-groups/${groupA.data.id}/memberships`, { token: admin });
  assert.deepEqual(groupMembersA.data.memberships.map(row => row.username), ["tenant_a_forecaster"]);
  assert.equal((await request(`/api/recipient-groups/${groupA.data.id}/memberships`, {
    token: forecasterB
  })).status, 403, "same-role users cannot enumerate recipient group membership administration");
  assert.equal((await request(`/api/recipient-group-memberships/${groupMembershipA.data.id}`, {
    token: admin, method: "PATCH", body: { status: "revoked" }
  })).status, 200);
  assert.equal((await request(`/api/recipient-group-memberships/${groupMembershipA.data.id}`, {
    token: admin, method: "PATCH", body: { status: "active" }
  })).status, 409, "revoked group membership cannot be resurrected");

  const alert = await request("/api/alerts", {
    token: forecasterA, method: "POST",
    body: {
      event: "Tenant isolation test",
      headline: "Tenant A test alert",
      description: "Synthetic integration-test alert",
      area_desc: "Test area",
      status: "Test",
      scope: "Public",
      info_blocks: [{
        category: "Met",
        event: "Tenant isolation test",
        urgency: "Unknown",
        severity: "Unknown",
        certainty: "Unknown",
        headline: "Tenant A test alert",
        description: "Synthetic integration-test alert",
        area: { areaDesc: "Test area" }
      }]
    }
  });
  assert.equal(alert.status, 201, "forecaster can create an isolated test alert");
  assert.equal((await request(`/api/alerts/${alert.data.id}/owner-organization`, {
    token: admin, method: "POST", body: { organization_id: organizationA.data.id }
  })).status, 200, "an unassigned alert can receive one explicit owner");
  assert.equal((await request(`/api/alerts/${alert.data.id}/owner-organization`, {
    token: admin, method: "POST", body: { organization_id: organizationB.data.id }
  })).status, 409, "alert ownership cannot be reassigned");

  const wrongTenantGrant = await request(`/api/alerts/${alert.data.id}/grants`, {
    token: admin, method: "POST",
    body: {
      owner_organization_id: organizationA.data.id,
      recipient_type: "user",
      recipient_user_id: 2,
      recipient_organization_id: organizationB.data.id,
      action: "read"
    }
  });
  assert.equal(wrongTenantGrant.status, 404,
    "a same-role user from organization A cannot receive a direct grant through organization B");

  const directGrant = await request(`/api/alerts/${alert.data.id}/grants`, {
    token: admin, method: "POST",
    body: {
      owner_organization_id: organizationA.data.id,
      recipient_type: "user",
      recipient_user_id: 3,
      recipient_organization_id: organizationB.data.id,
      action: "read"
    }
  });
  assert.equal(directGrant.status, 201);
  assert.equal((await request(`/api/alert-recipient-grants/${directGrant.data.id}`, {
    token: admin, method: "PATCH", body: { status: "active" }
  })).status, 200, "grant activation rechecks current organization membership");
  const alertGrants = await request(`/api/alerts/${alert.data.id}/grants`, { token: admin });
  assert.equal(alertGrants.status, 200);
  assert.deepEqual(alertGrants.data.grants.map(grant => grant.recipient_user_id), [3]);
  assert.equal((await request(`/api/alerts/${alert.data.id}/grants`, {
    token: forecasterB
  })).status, 403, "same-role recipients cannot enumerate administrative grant records");
  assert.equal((await request(`/api/alert-recipient-grants/${directGrant.data.id}`, {
    token: admin, method: "PATCH", body: { status: "revoked" }
  })).status, 200);
  assert.equal((await request(`/api/alert-recipient-grants/${directGrant.data.id}`, {
    token: admin, method: "PATCH", body: { status: "active" }
  })).status, 409, "revoked grants cannot be resurrected");

  const revoked = await request(`/api/organization-memberships/${membershipA.data.id}`, {
    token: admin, method: "PATCH", body: { status: "revoked" }
  });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.data.status, "revoked");
  const resurrection = await request(`/api/organization-memberships/${membershipA.data.id}`, {
    token: admin, method: "PATCH", body: { status: "active" }
  });
  assert.equal(resurrection.status, 409, "revoked membership cannot be reactivated");
  const newPeriod = await request(`/api/organizations/${organizationA.data.id}/memberships`, {
    token: admin, method: "POST", body: { user_id: 2 }
  });
  assert.equal(newPeriod.status, 201, "rejoining requires a new membership record");

  assert.equal((await request("/api/organizations", {
    token: admin, method: "POST", body: { slug: "tenant-a", name: "Duplicate Tenant" }
  })).status, 409, "organization slugs must be unique");
  assert.equal((await request(`/api/organizations/${organizationA.data.id}/memberships`, {
    token: admin, method: "POST", body: { user_id: 999999 }
  })).status, 404, "membership creation must not accept an unknown account");
});
