import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openReceiverStore } from "../tools/cap-receivers/receiver-store.mjs";
import assert from "node:assert/strict";
import { buildCapXml, makeIdentifier } from "../src/cap.js";
import { receiveCapXmlA } from "../tools/cap-receivers/receiver-a.mjs";
import { receiveCapXmlB } from "../tools/cap-receivers/receiver-b.mjs";

const base = {
  identifier: makeIdentifier(),
  sender: "phase7@example.test",
  sent: "2026-11-07T14:00:00.000Z",
  status: "Test",
  msg_type: "Alert",
  scope: "Public",
  event: "Receiver rainfall",
  category: "Met",
  urgency: "Expected",
  severity: "Moderate",
  certainty: "Likely",
  headline: "تحذير أمطار تجريبي",
  description: "Arabic and English interop fixture.",
  area_desc: "منطقة الاختبار",
  circle: "33.5,36.2 10",
  language: "ar"
};

test("phase7: independent receivers accept Public Alert and return Ack references", () => {
  const xml = buildCapXml(base);
  for (const receive of [receiveCapXmlA, receiveCapXmlB]) {
    const result = receive(xml);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.stored.identifier, base.identifier);
    assert.equal(result.ack.msgType, "Ack");
    assert.match(result.ack.references, new RegExp(base.identifier));
  }
});

test("phase7: receivers reject missing references on Update and invalid Restricted", () => {
  const originalAlert = receiveCapXmlA(buildCapXml(base));
  assert.equal(originalAlert.ok, true);
  const known = [originalAlert.stored];
  const updateXml = buildCapXml({
    identifier: makeIdentifier(),
    sender: base.sender,
    sent: "2026-11-07T14:05:00.000Z",
    status: "Test",
    msg_type: "Update",
    scope: "Public",
    references_text: `${base.sender},${base.identifier},${originalAlert.stored.sent}`,
    event: base.event,
    category: "Met",
    urgency: "Expected",
    severity: "Moderate",
    certainty: "Likely",
    headline: "Updated",
    description: "Update",
    area_desc: base.area_desc,
    circle: base.circle
  });
  assert.equal(receiveCapXmlA(updateXml, { knownMessages: known }).ok, true);
  assert.equal(receiveCapXmlB(updateXml, { knownMessages: known }).ok, true);
  const wrongReference = updateXml.replace(base.identifier, "urn:uuid:missing-target");
  assert.equal(receiveCapXmlA(wrongReference, { knownMessages: known }).ok, false);
  assert.equal(receiveCapXmlB(wrongReference, { knownMessages: known }).ok, false);

  const badUpdate = updateXml.replace(/<references>[\s\S]*?<\/references>/, "");
  assert.equal(receiveCapXmlA(badUpdate).ok, false);
  assert.equal(receiveCapXmlB(badUpdate).ok, false);

  const restrictedBad = buildCapXml({
    ...base,
    identifier: makeIdentifier(),
    scope: "Restricted",
    restriction: "internal only"
  }).replace(/<restriction>[\s\S]*?<\/restriction>/, "");
  assert.equal(receiveCapXmlA(restrictedBad).ok, false);
  assert.equal(receiveCapXmlB(restrictedBad).ok, false);
});

test("phase7: receivers accept CAP XML with an explicit namespace prefix", () => {
  const xml = buildCapXml(base)
    .replace('<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"', '<cap:alert xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2"')
    .replace('</alert>', '</cap:alert>')
    .replace(/<(\/?)([A-Za-z][A-Za-z0-9_.-]*)(?=[\s>])/g, (tag, slash, name) => `<${slash}cap:${name}`);
  for (const receive of [receiveCapXmlA, receiveCapXmlB]) {
    const result = receive(xml);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.stored.identifier, base.identifier);
  }
});

test("phase7: receivers reject DTD/entity declarations and malformed XML", () => {
  const hostile = `<!DOCTYPE alert [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><alert>&xxe;</alert>`;
  for (const receive of [receiveCapXmlA, receiveCapXmlB]) {
    assert.equal(receive(hostile).ok, false);
    assert.equal(receive("<alert><identifier></alert>").ok, false);
  }
});

test("phase7: receivers tolerate compacted XML and preserve Arabic headline via receiver B", () => {
  const xml = buildCapXml(base).replace(/>\s+</g, "><");
  assert.equal(receiveCapXmlA(xml).ok, true);
  const b = receiveCapXmlB(xml);
  assert.equal(b.ok, true);
  assert.match(b.stored.headline || base.headline, /تحذير|أمطار|تجريبي/);
});

test("phase7: receivers persist identities and deduplicate after restart", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cap-receiver-store-"));
  try {
    for (const [name, receive] of [["a", receiveCapXmlA], ["b", receiveCapXmlB]]) {
      const filename = path.join(root, name + ".sqlite");
      let db = openReceiverStore(filename);
      const xml = buildCapXml(base);
      const first = receive(xml, { database: db });
      assert.equal(first.ok, true, first.error);
      assert.equal(first.duplicate, false);
      const repeated = receive(xml, { database: db });
      assert.equal(repeated.ok, true, repeated.error);
      assert.equal(repeated.duplicate, true);
      db.close();
      db = openReceiverStore(filename);
      const rows = db.prepare("SELECT COUNT(*) AS n FROM receiver_messages").get().n;
      assert.equal(rows, 1);
      const repeatedAfterRestart = receive(xml, { database: db });
      assert.equal(repeatedAfterRestart.ok, true, repeatedAfterRestart.error);
      assert.equal(repeatedAfterRestart.duplicate, true);
      const update = buildCapXml({
        identifier: makeIdentifier(), sender: base.sender, sent: "2026-11-07T14:05:00.000Z",
        status: "Test", msg_type: "Update", scope: "Public",
        references_text: `${base.sender},${base.identifier},${first.stored.sent}`,
        event: base.event, category: "Met", urgency: "Expected", severity: "Moderate", certainty: "Likely",
        headline: "restart-safe update", description: "history survives receiver restart",
        area_desc: base.area_desc, circle: base.circle
      });
      assert.equal(receive(update, { database: db }).ok, true);
      db.close();
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("phase7: Update before its Alert is rejected by durable receiver history", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cap-receiver-order-"));
  const db = openReceiverStore(path.join(root, "receiver.sqlite"));
  try {
    const original = receiveCapXmlA(buildCapXml(base));
    const update = buildCapXml({
      identifier: makeIdentifier(), sender: base.sender, sent: "2026-11-07T15:00:00.000Z",
      status: "Test", msg_type: "Update", scope: "Public",
      references_text: `${base.sender},${base.identifier},${original.stored.sent}`,
      event: "x", category: "Met", urgency: "Expected", severity: "Minor", certainty: "Possible",
      headline: "early update", description: "before alert known", area_desc: "d", circle: "33,36 5"
    });
    const early = receiveCapXmlA(update, { database: db });
    assert.equal(early.ok, false);
    assert.match(early.error, /not present|reference/i);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM receiver_messages").get().n, 0);
    assert.equal(receiveCapXmlA(buildCapXml(base), { database: db }).ok, true);
    assert.equal(receiveCapXmlA(update, { database: db }).ok, true);
  } finally { db.close(); await fs.rm(root, { recursive: true, force: true }); }
});
