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

test("Restricted and Private alerts never leak through unauthenticated API surfaces", { timeout: 90000 }, async t => {
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
    return { status: response.status, headers: response.headers, data: await response.json().catch(() => ({})), text: null, response };
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
    ["iso_reviewer", "reviewer"],
    ["iso_publisher", "publisher"]
  ]) {
    assert.equal((await request("/api/users", {
      token: admin, method: "POST", body: { username, password: tempPassword, role }
    })).status, 201);
  }

  const activate = async (username) => {
    let token = await login(username, tempPassword);
    return changePassword(token, tempPassword, finalPassword);
  };
  const forecaster = await activate("iso_forecaster");
  const reviewer = await activate("iso_reviewer");
  const publisher = await activate("iso_publisher");

  async function publish(payload) {
    const created = await request("/api/alerts", { token: forecaster, method: "POST", body: payload });
    assert.equal(created.status, 201, "draft create: " + JSON.stringify(created.data));
    const id = created.data.id;
    assert.equal((await request(`/api/alerts/${id}/submit`, { token: forecaster, method: "POST", body: {} })).status, 200);
    assert.equal((await request(`/api/alerts/${id}/approve`, { token: reviewer, method: "POST", body: {} })).status, 200);
    assert.equal((await request(`/api/alerts/${id}/publish`, { token: publisher, method: "POST", body: {} })).status, 200);
    return created.data;
  }

  const publicAlert = await publish({
    event: "Isolation public",
    headline: "Isolation public headline unique-public-xyz",
    description: "Public isolation fixture",
    area_desc: "Isolation public area",
    circle: "33.1,36.1 6",
    status: "Actual",
    scope: "Public",
    urgency: "Expected",
    severity: "Moderate",
    certainty: "Likely"
  });
  const restrictedAlert = await publish({
    event: "Isolation restricted",
    headline: "Isolation restricted headline unique-restricted-xyz",
    description: "Restricted isolation fixture",
    area_desc: "Isolation restricted area",
    circle: "33.2,36.2 6",
    status: "Actual",
    scope: "Restricted",
    restriction: "Authorized agencies only",
    urgency: "Immediate",
    severity: "Severe",
    certainty: "Observed"
  });
  const privateAlert = await publish({
    event: "Isolation private",
    headline: "Isolation private headline unique-private-xyz",
    description: "Private isolation fixture",
    area_desc: "Isolation private area",
    circle: "33.3,36.3 6",
    status: "Actual",
    scope: "Private",
    addresses: "ops@example.test duty@example.test",
    urgency: "Expected",
    severity: "Minor",
    certainty: "Possible"
  });

  const sensitiveIds = [restrictedAlert.identifier, privateAlert.identifier];
  const sensitiveNeedles = [
    restrictedAlert.identifier,
    privateAlert.identifier,
    "unique-restricted-xyz",
    "unique-private-xyz",
    "Authorized agencies only",
    "ops@example.test"
  ];

  // Unauthenticated authenticated-only endpoints must reject.
  for (const url of [
    "/api/alerts",
    "/api/alerts?q=unique-restricted-xyz",
    "/api/alerts?scope=Restricted",
    "/api/alerts?scope=Private",
    "/api/alerts/export.csv",
    "/api/alerts/export.csv?q=unique-restricted-xyz",
    "/api/alerts/stats",
    `/api/alerts/${restrictedAlert.id}`,
    `/api/alerts/${privateAlert.id}`,
    `/api/alerts/${restrictedAlert.id}/cap.xml`,
    `/api/alerts/${privateAlert.id}/cap.xml`,
    `/api/alerts/${restrictedAlert.id}/relations`
  ]) {
    const response = await fetch(base + url);
    assert.equal(response.status, 401, `${url} must require authentication`);
    const body = await response.text();
    for (const needle of sensitiveNeedles) {
      assert.ok(!body.includes(needle), `${url} unauthenticated body must not contain ${needle}`);
    }
  }

  // Public feeds must include Public only and never sensitive identifiers/content.
  for (const url of ["/api/public/alerts", "/api/public/alerts.geojson"]) {
    const response = await fetch(base + url);
    assert.equal(response.status, 200, `${url} should be publicly readable`);
    assert.equal(response.headers.get("cache-control"), "no-store", `${url} must not be cached`);
    assert.equal(response.headers.get("pragma"), "no-cache", `${url} must send pragma no-cache`);
    const body = await response.text();
    assert.ok(body.includes(publicAlert.identifier), `${url} should include Public identifier`);
    for (const needle of sensitiveNeedles) {
      assert.ok(!body.includes(needle), `${url} must not leak sensitive content: ${needle}`);
    }
    if (url.endsWith("/alerts")) {
      const data = JSON.parse(body);
      assert.ok((data.alerts || []).every(alert => alert.scope === "Public"),
        "public JSON feed must only contain Public scope rows");
      assert.ok((data.alerts || []).every(alert => alert.status === "Actual"),
        "public JSON feed must only contain Actual status rows");
    }
  }

  // Authenticated search may find Restricted/Private (operators need this), but only with a token.
  const authedSearchRestricted = await request("/api/alerts?q=unique-restricted-xyz", { token: forecaster });
  assert.equal(authedSearchRestricted.status, 200);
  assert.ok((authedSearchRestricted.data.alerts || []).some(alert => alert.identifier === restrictedAlert.identifier),
    "authenticated search may return Restricted for operators");

  const authedSearchPrivate = await request("/api/alerts?q=unique-private-xyz", { token: forecaster });
  assert.equal(authedSearchPrivate.status, 200);
  assert.ok((authedSearchPrivate.data.alerts || []).some(alert => alert.identifier === privateAlert.identifier),
    "authenticated search may return Private for operators");

  // Authenticated CSV export may include Restricted/Private; unauthenticated must not.
  const csvAuthed = await fetch(base + "/api/alerts/export.csv?q=unique-restricted-xyz", {
    headers: { Authorization: "Bearer " + forecaster }
  });
  assert.equal(csvAuthed.status, 200);
  const csvText = await csvAuthed.text();
  assert.ok(csvText.includes(restrictedAlert.identifier), "authenticated CSV may include Restricted rows");
  assert.equal(csvAuthed.headers.get("cache-control"), "no-store", "CSV export must not be cached");

  const csvUnauthed = await fetch(base + "/api/alerts/export.csv?q=unique-restricted-xyz");
  assert.equal(csvUnauthed.status, 401);
  const csvUnauthedText = await csvUnauthed.text();
  for (const id of sensitiveIds) {
    assert.ok(!csvUnauthedText.includes(id), "unauthenticated CSV must not include sensitive identifiers");
  }

  // CAP XML for Restricted/Private requires auth and remains no-store when authorized.
  for (const id of [restrictedAlert.id, privateAlert.id]) {
    const denied = await fetch(base + `/api/alerts/${id}/cap.xml`);
    assert.equal(denied.status, 401);
    const allowed = await fetch(base + `/api/alerts/${id}/cap.xml`, {
      headers: { Authorization: "Bearer " + forecaster }
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("cache-control"), "no-store");
    const xml = await allowed.text();
    assert.match(xml, /<alert[\s>]/);
  }
});
