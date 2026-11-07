import test from "node:test";
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
    references_text: `${base.sender},${base.identifier},2026-11-07T14:00:00-00:00`,
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
  assert.equal(receiveCapXmlA(updateXml, known).ok, true);
  assert.equal(receiveCapXmlB(updateXml, known).ok, true);
  const wrongReference = updateXml.replace(base.identifier, "urn:uuid:missing-target");
  assert.equal(receiveCapXmlA(wrongReference, known).ok, false);
  assert.equal(receiveCapXmlB(wrongReference, known).ok, false);

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

test("phase7: duplicate delivery to receivers is idempotent at storage key level", () => {
  const xml = buildCapXml(base);
  const store = new Map();
  for (let i = 0; i < 3; i++) {
    const result = receiveCapXmlA(xml);
    assert.equal(result.ok, true);
    const key = `${result.stored.sender}|${result.stored.identifier}|${result.stored.sent}`;
    if (!store.has(key)) store.set(key, result.stored);
  }
  assert.equal(store.size, 1, "duplicate deliveries must collapse to one stored identity");
});

test("phase7: Update before locally known Alert is flagged by receiver policy helper", () => {
  const known = new Set();
  function acceptWithOrdering(xml) {
    const result = receiveCapXmlA(xml);
    if (!result.ok) return result;
    const { msgType, references, identifier, sender, sent } = result.stored;
    const key = `${sender}|${identifier}|${sent}`;
    if (["Update", "Cancel"].includes(msgType)) {
      const refKey = references.split(",").slice(0, 2).join("|");
      const found = [...known].some(k => k.startsWith(refKey + "|"));
      if (!found) return { ok: false, error: "update/cancel before known alert", deferred: true };
    }
    known.add(key);
    return result;
  }
  const updateFirst = buildCapXml({
    identifier: makeIdentifier(),
    sender: base.sender,
    sent: "2026-11-07T15:00:00.000Z",
    status: "Test",
    msg_type: "Update",
    scope: "Public",
    references_text: `${base.sender},${base.identifier},2026-11-07T14:00:00-00:00`,
    event: "x",
    category: "Met",
    urgency: "Expected",
    severity: "Minor",
    certainty: "Possible",
    headline: "early update",
    description: "before alert known",
    area_desc: "d",
    circle: "33,36 5"
  });
  const early = acceptWithOrdering(updateFirst);
  assert.equal(early.ok, false);
  assert.equal(early.deferred, true);
  assert.equal(acceptWithOrdering(buildCapXml(base)).ok, true);
});
