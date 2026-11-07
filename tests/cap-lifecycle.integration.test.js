import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const serverEntry = fileURLToPath(new URL("../src/server.js", import.meta.url));
const schemaPath = process.env.CAP_XSD_PATH || path.resolve("schemas/CAP-v1.2.xsd");
const hasSchema = existsSync(schemaPath);
const hasXmllint = spawnSync("xmllint", ["--version"], { encoding: "utf8" }).status === 0;

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

async function writeAndValidateXml(xml, label) {
  assert.match(xml, /<alert[\s>]/, `${label}: XML must contain alert element`);
  assert.match(xml, /urn:oasis:names:tc:emergency:cap:1\.2/, `${label}: XML must use CAP 1.2 namespace`);
  if (!hasSchema || !hasXmllint) return { xsd: "skipped" };
  const dir = await mkdtemp(path.join(tmpdir(), "cap-lifecycle-xsd-"));
  try {
    const xmlPath = path.join(dir, "message.xml");
    await writeFile(xmlPath, xml, "utf8");
    const result = spawnSync("xmllint", ["--noout", "--schema", schemaPath, xmlPath], { encoding: "utf8" });
    assert.equal(result.status, 0, `${label}: OASIS XSD validation failed: ${result.stderr || result.stdout}`);
    return { xsd: "passed" };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("CAP lifecycle covers Public, Restricted, Private, Update, Cancel, relations and public-feed isolation", { timeout: 90000 }, async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), "meteo-cap-lifecycle-"));
  const port = await reservePort();
  const base = "http://127.0.0.1:" + port;
  const adminPassword = "Lifecycle-Test-Admin-Password-2026!";
  const child = spawn(process.execPath, [serverEntry], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      JWT_SECRET: "lifecycle-test-secret-that-is-at-least-32-characters",
      ADMIN_PASSWORD: adminPassword,
      CAP_DELIVERY_ENABLED: "true",
      MFA_ENCRYPTION_KEY: "b".repeat(64),
      MFA_REQUIRED_ROLES: "",
      API_RATE_LIMIT: "5000",
      CAP_SENDER: "lifecycle@example.test"
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
  assert.equal(ready, true, "lifecycle API server should become ready");

  const request = async (url, { token, method = "GET", body } = {}) => {
    const response = await fetch(base + url, {
      method,
      headers: {
        ...(token ? { Authorization: "Bearer " + token } : {}),
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, headers: response.headers, data: await response.json().catch(() => ({})) };
  };

  const login = async (username, password) => {
    const result = await request("/api/auth/login", { method: "POST", body: { username, password } });
    assert.equal(result.status, 200, "login should succeed for " + username);
    return result.data.token;
  };

  const changePassword = async (token, currentPassword, newPassword) => {
    const changed = await request("/api/auth/change-password", {
      token, method: "POST",
      body: { currentPassword, newPassword }
    });
    assert.equal(changed.status, 200, "password change should succeed: " + JSON.stringify(changed.data));
    assert.ok(changed.data.token, "password change should return a replacement session token");
    return changed.data.token;
  };

  // Admin bootstrap uses a temporary password that must be changed before privileged operations.
  let admin = await login("admin", adminPassword);
  admin = await changePassword(admin, adminPassword, adminPassword + "X");

  const tempPassword = "Lifecycle-Role-Password-2026!";
  const finalPassword = "Lifecycle-Role-Password-Final-2026!";
  for (const [username, role] of [
    ["forecaster1", "forecaster"],
    ["reviewer1", "reviewer"],
    ["publisher1", "publisher"]
  ]) {
    const created = await request("/api/users", {
      token: admin, method: "POST",
      body: { username, password: tempPassword, role }
    });
    assert.equal(created.status, 201, `should create ${role} account: ${JSON.stringify(created.data)}`);
  }

  const loginAndActivate = async (username) => {
    let token = await login(username, tempPassword);
    token = await changePassword(token, tempPassword, finalPassword);
    return token;
  };

  const forecaster = await loginAndActivate("forecaster1");
  const reviewer = await loginAndActivate("reviewer1");
  const publisher = await loginAndActivate("publisher1");

  async function publishThroughWorkflow(tokenAuthor, payload, label) {
    const created = await request("/api/alerts", { token: tokenAuthor, method: "POST", body: payload });
    assert.equal(created.status, 201, `${label}: draft create should succeed: ${JSON.stringify(created.data)}`);
    const id = created.data.id;
    const identifier = created.data.identifier;

    assert.equal((await request(`/api/alerts/${id}/submit`, { token: tokenAuthor, method: "POST", body: {} })).status, 200,
      `${label}: submit should succeed`);
    assert.equal((await request(`/api/alerts/${id}/approve`, { token: reviewer, method: "POST", body: {} })).status, 200,
      `${label}: independent approve should succeed`);
    const published = await request(`/api/alerts/${id}/publish`, { token: publisher, method: "POST", body: {} });
    assert.equal(published.status, 200, `${label}: independent publish should succeed: ${JSON.stringify(published.data)}`);

    const xmlResponse = await fetch(base + `/api/alerts/${id}/cap.xml`, {
      headers: { Authorization: "Bearer " + tokenAuthor }
    });
    assert.equal(xmlResponse.status, 200, `${label}: CAP XML export should succeed`);
    const xml = await xmlResponse.text();
    await writeAndValidateXml(xml, label);
    return { id, identifier, xml, delivery: published.data.delivery };
  }

  // --- Public Actual lifecycle ---
  const publicAlert = await publishThroughWorkflow(forecaster, {
    event: "Lifecycle public storm",
    headline: "Public lifecycle storm warning",
    description: "Public-scope actual warning for lifecycle testing only.",
    area_desc: "Lifecycle public district",
    circle: "33.50,36.30 12",
    category: "Met",
    urgency: "Expected",
    severity: "Moderate",
    certainty: "Likely",
    status: "Actual",
    scope: "Public",
    language: "en-US"
  }, "Public Actual");

  assert.match(publicAlert.xml, /<scope>Public<\/scope>/);
  assert.doesNotMatch(publicAlert.xml, /<restriction>/);
  assert.doesNotMatch(publicAlert.xml, /<addresses>/);

  // --- Restricted Actual lifecycle ---
  const restrictedAlert = await publishThroughWorkflow(forecaster, {
    event: "Lifecycle restricted storm",
    headline: "Restricted lifecycle storm warning",
    description: "Restricted-scope actual warning for authorized agencies only.",
    area_desc: "Lifecycle restricted district",
    circle: "34.00,36.50 8",
    category: "Met",
    urgency: "Immediate",
    severity: "Severe",
    certainty: "Observed",
    status: "Actual",
    scope: "Restricted",
    restriction: "Internal distribution to authorized meteorological partners only",
    language: "en-US"
  }, "Restricted Actual");

  assert.match(restrictedAlert.xml, /<scope>Restricted<\/scope>/);
  assert.match(restrictedAlert.xml, /<restriction>Internal distribution to authorized meteorological partners only<\/restriction>/);

  // --- Private Actual lifecycle ---
  const privateAlert = await publishThroughWorkflow(forecaster, {
    event: "Lifecycle private storm",
    headline: "Private lifecycle storm warning",
    description: "Private-scope actual warning for named recipients only.",
    area_desc: "Lifecycle private desk",
    circle: "33.20,36.10 5",
    category: "Met",
    urgency: "Expected",
    severity: "Minor",
    certainty: "Possible",
    status: "Actual",
    scope: "Private",
    addresses: "ops@example.test duty@example.test",
    language: "en-US"
  }, "Private Actual");

  assert.match(privateAlert.xml, /<scope>Private<\/scope>/);
  assert.match(privateAlert.xml, /<addresses>ops@example.test duty@example.test<\/addresses>/);

  // --- Public feed isolation ---
  const publicFeed = await request("/api/public/alerts");
  assert.equal(publicFeed.status, 200);
  const feedIds = new Set((publicFeed.data.alerts || []).map(alert => alert.identifier));
  assert.ok(feedIds.has(publicAlert.identifier), "Public Actual published alert must appear on public feed");
  assert.ok(!feedIds.has(restrictedAlert.identifier), "Restricted Actual must never appear on public feed");
  assert.ok(!feedIds.has(privateAlert.identifier), "Private Actual must never appear on public feed");

  const geoFeed = await request("/api/public/alerts.geojson");
  assert.equal(geoFeed.status, 200);
  const geoIds = new Set((geoFeed.data.features || []).map(feature => feature.properties?.identifier).filter(Boolean));
  assert.ok(geoIds.has(publicAlert.identifier), "Public Actual must appear on GeoJSON feed");
  assert.ok(!geoIds.has(restrictedAlert.identifier), "Restricted Actual must never appear on GeoJSON feed");
  assert.ok(!geoIds.has(privateAlert.identifier), "Private Actual must never appear on GeoJSON feed");

  // --- Update and Cancel on Public published alert ---
  const updateDraft = await request(`/api/alerts/${publicAlert.id}/derive`, {
    token: forecaster, method: "POST", body: { msg_type: "Update" }
  });
  assert.equal(updateDraft.status, 201, "Update derive should create a Test draft");
  assert.equal(updateDraft.data.status, "Test");
  assert.equal(updateDraft.data.msg_type, "Update");
  assert.ok(updateDraft.data.references?.includes(publicAlert.identifier), "Update must reference original identifier");

  assert.equal((await request(`/api/alerts/${updateDraft.data.id}/submit`, { token: forecaster, method: "POST", body: {} })).status, 200);
  assert.equal((await request(`/api/alerts/${updateDraft.data.id}/approve`, { token: reviewer, method: "POST", body: {} })).status, 200);
  const updatePublished = await request(`/api/alerts/${updateDraft.data.id}/publish`, { token: publisher, method: "POST", body: {} });
  assert.equal(updatePublished.status, 200, "Update publish should succeed: " + JSON.stringify(updatePublished.data));

  const updateXmlResponse = await fetch(base + `/api/alerts/${updateDraft.data.id}/cap.xml`, {
    headers: { Authorization: "Bearer " + forecaster }
  });
  assert.equal(updateXmlResponse.status, 200);
  const updateXml = await updateXmlResponse.text();
  await writeAndValidateXml(updateXml, "Public Update");
  assert.match(updateXml, /<msgType>Update<\/msgType>/);
  assert.match(updateXml, /<references>/);

  const cancelDraft = await request(`/api/alerts/${publicAlert.id}/derive`, {
    token: forecaster, method: "POST", body: { msg_type: "Cancel" }
  });
  assert.equal(cancelDraft.status, 201, "Cancel derive should create a Test draft");
  assert.equal(cancelDraft.data.msg_type, "Cancel");

  assert.equal((await request(`/api/alerts/${cancelDraft.data.id}/submit`, { token: forecaster, method: "POST", body: {} })).status, 200);
  assert.equal((await request(`/api/alerts/${cancelDraft.data.id}/approve`, { token: reviewer, method: "POST", body: {} })).status, 200);
  const cancelPublished = await request(`/api/alerts/${cancelDraft.data.id}/publish`, { token: publisher, method: "POST", body: {} });
  assert.equal(cancelPublished.status, 200, "Cancel publish should succeed: " + JSON.stringify(cancelPublished.data));

  const cancelXmlResponse = await fetch(base + `/api/alerts/${cancelDraft.data.id}/cap.xml`, {
    headers: { Authorization: "Bearer " + forecaster }
  });
  assert.equal(cancelXmlResponse.status, 200);
  const cancelXml = await cancelXmlResponse.text();
  await writeAndValidateXml(cancelXml, "Public Cancel");
  assert.match(cancelXml, /<msgType>Cancel<\/msgType>/);
  assert.match(cancelXml, /<references>/);

  // --- Restricted and Private Update/Cancel derivation ---
  async function derivePublishAndValidate(source, msgType, label, xmlAssertions = []) {
    const derived = await request(`/api/alerts/${source.id}/derive`, {
      token: forecaster, method: "POST", body: { msg_type: msgType }
    });
    assert.equal(derived.status, 201, `${label}: derive ${msgType} should succeed: ${JSON.stringify(derived.data)}`);
    assert.equal(derived.data.msg_type, msgType);
    assert.equal(derived.data.status, "Test");
    assert.ok(String(derived.data.references || "").includes(source.identifier),
      `${label}: ${msgType} must reference the source identifier`);

    assert.equal((await request(`/api/alerts/${derived.data.id}/submit`, { token: forecaster, method: "POST", body: {} })).status, 200,
      `${label}: ${msgType} submit should succeed`);
    assert.equal((await request(`/api/alerts/${derived.data.id}/approve`, { token: reviewer, method: "POST", body: {} })).status, 200,
      `${label}: ${msgType} approve should succeed`);
    const published = await request(`/api/alerts/${derived.data.id}/publish`, { token: publisher, method: "POST", body: {} });
    assert.equal(published.status, 200, `${label}: ${msgType} publish should succeed: ${JSON.stringify(published.data)}`);

    const xmlResponse = await fetch(base + `/api/alerts/${derived.data.id}/cap.xml`, {
      headers: { Authorization: "Bearer " + forecaster }
    });
    assert.equal(xmlResponse.status, 200, `${label}: ${msgType} CAP XML export should succeed`);
    const xml = await xmlResponse.text();
    await writeAndValidateXml(xml, `${label} ${msgType}`);
    assert.match(xml, new RegExp(`<msgType>${msgType}</msgType>`));
    assert.match(xml, /<references>/);
    for (const assertion of xmlAssertions) assertion(xml);
    return { ...derived.data, xml };
  }

  const restrictedUpdate = await derivePublishAndValidate(restrictedAlert, "Update", "Restricted", [
    xml => assert.match(xml, /<scope>Restricted<\/scope>/),
    xml => assert.match(xml, /<restriction>Internal distribution to authorized meteorological partners only<\/restriction>/)
  ]);
  const restrictedCancel = await derivePublishAndValidate(restrictedAlert, "Cancel", "Restricted", [
    xml => assert.match(xml, /<scope>Restricted<\/scope>/),
    xml => assert.match(xml, /<restriction>Internal distribution to authorized meteorological partners only<\/restriction>/)
  ]);
  const privateUpdate = await derivePublishAndValidate(privateAlert, "Update", "Private", [
    xml => assert.match(xml, /<scope>Private<\/scope>/),
    xml => assert.match(xml, /<addresses>ops@example.test duty@example.test<\/addresses>/)
  ]);
  const privateCancel = await derivePublishAndValidate(privateAlert, "Cancel", "Private", [
    xml => assert.match(xml, /<scope>Private<\/scope>/),
    xml => assert.match(xml, /<addresses>ops@example.test duty@example.test<\/addresses>/)
  ]);

  // --- Relations / lineage integrity ---
  for (const [source, updateId, cancelId, label] of [
    [publicAlert, updateDraft.data.identifier, cancelDraft.data.identifier, "Public"],
    [restrictedAlert, restrictedUpdate.identifier, restrictedCancel.identifier, "Restricted"],
    [privateAlert, privateUpdate.identifier, privateCancel.identifier, "Private"]
  ]) {
    const relations = await request(`/api/alerts/${source.id}/relations`, { token: forecaster });
    assert.equal(relations.status, 200, `${label}: relations endpoint should succeed`);
    assert.ok(relations.data.count >= 3, `${label}: lineage should include original, update and cancel`);
    const relationTypes = new Set((relations.data.messages || []).map(message => message.msg_type));
    assert.ok(relationTypes.has("Alert"), `${label}: relations must include original Alert`);
    assert.ok(relationTypes.has("Update"), `${label}: relations must include Update`);
    assert.ok(relationTypes.has("Cancel"), `${label}: relations must include Cancel`);
    assert.ok((relations.data.relations || []).length >= 2, `${label}: CAP reference edges should link derived messages`);
    const identifiers = new Set((relations.data.messages || []).map(message => message.identifier));
    assert.ok(identifiers.has(source.identifier), `${label}: relations include source identifier`);
    assert.ok(identifiers.has(updateId), `${label}: relations include Update identifier`);
    assert.ok(identifiers.has(cancelId), `${label}: relations include Cancel identifier`);
    for (const edge of relations.data.relations || []) {
      assert.match(String(edge.reference || ""), /,.+,/, `${label}: relation reference must be a CAP triplet`);
    }
  }

  // --- Database integrity checks ---
  const dbPath = path.join(cwd, "storage", "cap.sqlite");
  assert.equal(existsSync(dbPath), true, "SQLite database should exist after lifecycle operations");
  const db = new Database(dbPath, { readonly: true });
  try {
    const quick = db.pragma("quick_check");
    assert.equal(quick[0].quick_check, "ok", "SQLite quick_check must pass after lifecycle");
    const fk = db.pragma("foreign_key_check");
    assert.equal(fk.length, 0, "foreign key check must find no violations");

    const byScope = db.prepare("SELECT scope, COUNT(*) AS n FROM alerts WHERE workflow='published' GROUP BY scope").all();
    const scopeMap = Object.fromEntries(byScope.map(row => [row.scope, row.n]));
    assert.ok((scopeMap.Public || 0) >= 1, "published Public alerts should exist");
    assert.ok((scopeMap.Restricted || 0) >= 1, "published Restricted alerts should exist");
    assert.ok((scopeMap.Private || 0) >= 1, "published Private alerts should exist");

    const leaked = db.prepare(`
      SELECT identifier, scope, status, workflow, msg_type FROM alerts
      WHERE workflow='published' AND scope IN ('Restricted','Private')
    `).all();
    assert.ok(leaked.length >= 6, "Restricted/Private published Alert/Update/Cancel rows should exist in DB");

    // Re-check public feed SQL contract against DB state
    const publicRows = db.prepare(`
      SELECT identifier FROM alerts
      WHERE workflow='published' AND scope='Public' AND status='Actual'
        AND (expires IS NULL OR expires='' OR julianday(expires)>julianday('now'))
    `).all().map(row => row.identifier);
    for (const row of leaked) {
      assert.ok(!publicRows.includes(row.identifier),
        `DB public-feed query must not include ${row.scope} ${row.msg_type} identifier ${row.identifier}`);
    }

    const cancelRow = db.prepare("SELECT workflow, msg_type, references_text FROM alerts WHERE identifier=?").get(cancelDraft.data.identifier);
    assert.equal(cancelRow.msg_type, "Cancel");
    assert.equal(cancelRow.workflow, "published");
    assert.match(cancelRow.references_text || "", new RegExp(publicAlert.identifier));

    const restrictedCancelRow = db.prepare("SELECT scope, restriction, references_text FROM alerts WHERE identifier=?").get(restrictedCancel.identifier);
    assert.equal(restrictedCancelRow.scope, "Restricted");
    assert.match(restrictedCancelRow.restriction || "", /authorized meteorological partners/);
    assert.match(restrictedCancelRow.references_text || "", new RegExp(restrictedAlert.identifier));

    const privateUpdateRow = db.prepare("SELECT scope, addresses, references_text FROM alerts WHERE identifier=?").get(privateUpdate.identifier);
    assert.equal(privateUpdateRow.scope, "Private");
    assert.match(privateUpdateRow.addresses || "", /ops@example\.test/);
    assert.match(privateUpdateRow.references_text || "", new RegExp(privateAlert.identifier));

    const outbox = db.prepare("SELECT COUNT(*) AS n FROM delivery_outbox").get();
    assert.ok(outbox.n >= 9, "each successful publish should enqueue an internal outbox entry");
  } finally {
    db.close();
  }

  // Restricted/Private and their derivatives remain absent from public feeds
  const publicFeedAfter = await request("/api/public/alerts");
  const afterIds = new Set((publicFeedAfter.data.alerts || []).map(alert => alert.identifier));
  for (const identifier of [
    restrictedAlert.identifier, restrictedUpdate.identifier, restrictedCancel.identifier,
    privateAlert.identifier, privateUpdate.identifier, privateCancel.identifier
  ]) {
    assert.ok(!afterIds.has(identifier), `public JSON feed must not include non-Public identifier ${identifier}`);
  }
  const geoAfter = await request("/api/public/alerts.geojson");
  const geoAfterIds = new Set((geoAfter.data.features || []).map(feature => feature.properties?.identifier).filter(Boolean));
  for (const identifier of [
    restrictedAlert.identifier, restrictedUpdate.identifier, restrictedCancel.identifier,
    privateAlert.identifier, privateUpdate.identifier, privateCancel.identifier
  ]) {
    assert.ok(!geoAfterIds.has(identifier), `public GeoJSON feed must not include non-Public identifier ${identifier}`);
  }
});

test("CAP Ack and Error messages validate against OASIS XSD with required references", { timeout: 30000 }, async () => {
  const { buildCapXml, makeIdentifier } = await import("../src/cap.js");
  const references = "lifecycle@example.test,urn:uuid:source-message,2026-11-07T00:00:00-00:00";
  for (const msg_type of ["Ack", "Error"]) {
    const xml = buildCapXml({
      identifier: makeIdentifier(),
      sender: "lifecycle@example.test",
      sent: "2026-11-07T01:00:00.000Z",
      status: "Test",
      msg_type,
      scope: "Public",
      references_text: references
    });
    assert.match(xml, new RegExp(`<msgType>${msg_type}</msgType>`));
    assert.match(xml, /<references>/);
    assert.doesNotMatch(xml, /<info>/, `${msg_type} messages should not require info blocks`);
    await writeAndValidateXml(xml, msg_type);
  }
});
