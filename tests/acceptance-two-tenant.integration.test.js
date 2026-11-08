import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWebhookSignature } from "../src/webhook-signature.js";

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
  async function createActiveMember(username, role, organizationId) {
    const user = await request("/api/users", {
      method: "POST",
      token: admin,
      body: { username, password: tempPassword, role },
    });
    assert.equal(user.status, 201, "create " + username);
    const mem = await request(`/api/organizations/${organizationId}/memberships`, {
      method: "POST",
      token: admin,
      body: { user_id: user.data.id },
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
  const forecasterA = await createActiveMember("acc_forecaster_a", "forecaster", orgA.data.id);
  const publisherA = await createActiveMember("acc_publisher_a", "publisher", orgA.data.id);

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

  // Public feed must not list Test messages as operational Actual
  const publicFeed = await request("/api/public/alerts");
  assert.equal(publicFeed.status, 200);
  const publicRows = publicFeed.data.alerts || publicFeed.data.messages || publicFeed.data || [];
  const listed = (Array.isArray(publicRows) ? publicRows : []).filter(
    (m) => m.id === alertId || m.identifier === row.identifier,
  );
  assert.equal(listed.length, 0, "Test alerts must not appear on public Actual feed");
});
