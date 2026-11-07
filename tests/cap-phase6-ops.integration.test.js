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

test("phase6: concurrent workflow safety, metrics and retention controls", { timeout: 120000 }, async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), "meteo-cap-phase6-"));
  const port = await reservePort();
  const base = "http://127.0.0.1:" + port;
  const adminPassword = "Phase6-Admin-Password-2026!!";
  const child = spawn(process.execPath, [serverEntry], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      JWT_SECRET: "phase6-test-secret-that-is-at-least-32-characters",
      ADMIN_PASSWORD: adminPassword,
      CAP_DELIVERY_ENABLED: "true",
      MFA_ENCRYPTION_KEY: "1".repeat(64),
      MFA_REQUIRED_ROLES: "",
      API_RATE_LIMIT: "5000",
      CAP_SENDER: "phase6@example.test"
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
    if (child.exitCode !== null) throw new Error("server exited early");
    try {
      if ((await fetch(base + "/api/health")).ok) { ready = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 100));
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
  const login = async (u, p) => {
    const r = await request("/api/auth/login", { method: "POST", body: { username: u, password: p } });
    assert.equal(r.status, 200);
    return r.data.token;
  };
  const changePassword = async (token, currentPassword, newPassword) => {
    const r = await request("/api/auth/change-password", {
      token, method: "POST", body: { currentPassword, newPassword }
    });
    assert.equal(r.status, 200);
    return r.data.token;
  };

  let admin = await login("admin", adminPassword);
  admin = await changePassword(admin, adminPassword, adminPassword + "X");
  const tempPassword = "Phase6-Role-Password-2026!";
  const finalPassword = "Phase6-Role-Password-Final-2026!";
  for (const [username, role] of [["p6_f", "forecaster"], ["p6_r", "reviewer"], ["p6_p", "publisher"]]) {
    assert.equal((await request("/api/users", {
      token: admin, method: "POST", body: { username, password: tempPassword, role }
    })).status, 201);
  }
  const activate = async (username) => {
    let token = await login(username, tempPassword);
    return changePassword(token, tempPassword, finalPassword);
  };
  const forecaster = await activate("p6_f");
  const reviewer = await activate("p6_r");
  const publisher = await activate("p6_p");

  // Concurrent draft creation stress
  const creates = await Promise.all(Array.from({ length: 8 }, (_, i) => request("/api/alerts", {
    token: forecaster, method: "POST", body: {
      event: "Phase6 stress " + i,
      headline: "Phase6 stress headline " + i,
      description: "Concurrent create fixture " + i,
      area_desc: "Phase6 area",
      circle: "33.5,36.2 5",
      status: "Test",
      scope: "Public",
      urgency: "Expected",
      severity: "Moderate",
      certainty: "Likely"
    }
  })));
  assert.ok(creates.every(result => result.status === 201), "all concurrent creates should succeed");
  const ids = creates.map(result => result.data.id);

  // Concurrent submit of distinct drafts
  const submits = await Promise.all(ids.map(id => request(`/api/alerts/${id}/submit`, {
    token: forecaster, method: "POST", body: {}
  })));
  assert.ok(submits.every(result => result.status === 200), "all concurrent submits should succeed");

  // Metrics require auth and report outbox/adapters flag
  assert.equal((await request("/api/health/metrics")).status, 401);
  const metrics = await request("/api/health/metrics", { token: admin });
  assert.equal(metrics.status, 200);
  assert.equal(metrics.data.metrics.external_adapters_enabled, false);
  assert.ok(metrics.data.metrics.database.quick_check === "ok");
  assert.ok(typeof metrics.data.metrics.delivery_outbox.queued === "number");

  // Publisher can also read metrics; forecaster cannot
  assert.equal((await request("/api/health/metrics", { token: publisher })).status, 200);
  assert.equal((await request("/api/health/metrics", { token: forecaster })).status, 403);

  // Retention apply is admin-only and never claims audit deletion
  assert.equal((await request("/api/ops/retention/apply", { token: publisher, method: "POST", body: {} })).status, 403);
  const retention = await request("/api/ops/retention/apply", {
    token: admin, method: "POST", body: { delivery_retention_days: 90, webhook_retention_days: 90 }
  });
  assert.equal(retention.status, 200, JSON.stringify(retention.data));
  assert.equal(retention.data.audit_log.deleted, 0);
  assert.equal(retention.data.ok, true);

  // Health still advertises adapters disabled
  const health = await request("/api/health");
  assert.equal(health.data.external_adapters_enabled, false);
});
