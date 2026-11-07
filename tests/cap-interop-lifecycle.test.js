import test from "node:test";
import assert from "node:assert/strict";
import { buildCapXml, makeIdentifier, parseCapXml, roundTripCap, validateAlert } from "../src/cap.js";

const base = {
  identifier: makeIdentifier(),
  sender: "interop@example.test",
  sent: "2026-11-07T12:00:00.000Z",
  status: "Test",
  msg_type: "Alert",
  scope: "Public",
  event: "Interop rainfall",
  category: "Met",
  urgency: "Expected",
  severity: "Moderate",
  certainty: "Likely",
  headline: "Interop CAP rainfall warning",
  description: "Interoperability round-trip fixture.",
  area_desc: "Interop district",
  circle: "33.5,36.2 10",
  language: "en-US"
};

test("CAP XML round-trip preserves semantic header and area fields", () => {
  const { xml, parsed, xmlAgain } = roundTripCap(base);
  assert.match(xml, /<alert/);
  assert.equal(parsed.identifier, base.identifier);
  assert.equal(parsed.sender, base.sender);
  assert.equal(parsed.msg_type, "Alert");
  assert.equal(parsed.scope, "Public");
  assert.equal(parsed.event, base.event);
  assert.equal(parsed.headline, base.headline);
  assert.equal(parsed.area_desc, base.area_desc);
  assert.equal(parsed.circle, base.circle);
  assert.equal(validateAlert(parsed), true);
  const second = parseCapXml(xmlAgain);
  assert.equal(second.identifier, base.identifier);
  assert.equal(second.event, base.event);
});

test("CAP XML parse tolerates compacted whitespace while preserving semantics", () => {
  const pretty = buildCapXml(base);
  const compact = pretty.replace(/>\s+</g, "><").trim();
  const parsed = parseCapXml(compact);
  assert.equal(parsed.identifier, base.identifier);
  assert.equal(parsed.scope, "Public");
  assert.equal(parsed.area_desc, base.area_desc);
});

test("Update Cancel Ack Error round-trip preserve references", () => {
  const references = "interop@example.test,urn:uuid:source,2026-11-07T11:00:00-00:00";
  for (const msg_type of ["Update", "Cancel", "Ack", "Error"]) {
    const input = {
      identifier: makeIdentifier(),
      sender: "interop@example.test",
      sent: "2026-11-07T12:30:00.000Z",
      status: "Test",
      msg_type,
      scope: "Public",
      references_text: references,
      ...(msg_type === "Update" ? {
        event: "Interop rainfall",
        category: "Met",
        urgency: "Expected",
        severity: "Moderate",
        certainty: "Likely",
        headline: "Updated interop warning",
        description: "Update fixture",
        area_desc: "Interop district",
        circle: "33.5,36.2 10"
      } : {})
    };
    const { parsed } = roundTripCap(input);
    assert.equal(parsed.msg_type, msg_type);
    assert.equal(parsed.references_text, references);
  }
});

test("Restricted and Private scope fields survive export/import", () => {
  const restricted = roundTripCap({
    ...base,
    identifier: makeIdentifier(),
    scope: "Restricted",
    restriction: "Authorized agencies only"
  }).parsed;
  assert.equal(restricted.scope, "Restricted");
  assert.equal(restricted.restriction, "Authorized agencies only");

  const privateMsg = roundTripCap({
    ...base,
    identifier: makeIdentifier(),
    scope: "Private",
    addresses: "ops@example.test duty@example.test"
  }).parsed;
  assert.equal(privateMsg.scope, "Private");
  assert.equal(privateMsg.addresses, "ops@example.test duty@example.test");
});

test("parseCapXml rejects malformed, wrong-namespace and unsafe XML documents", () => {
  assert.throws(() => parseCapXml("<not-cap/>"), /alert element|well-formed|CAP/i);
  assert.throws(() => parseCapXml("not xml at all"), /well-formed|CAP/i);
  const valid = buildCapXml(base);
  const broken = valid.replace("<severity>Moderate</severity>", "<severity>Critical</severity>");
  assert.throws(() => parseCapXml(broken), /Invalid CAP|severity/i);
  const missingNamespace = valid.replace(' xmlns="urn:oasis:names:tc:emergency:cap:1.2"', "");
  assert.throws(() => parseCapXml(missingNamespace), /CAP 1.2 namespace/i);
  const wrongNamespace = valid.replace("urn:oasis:names:tc:emergency:cap:1.2", "urn:example:not-cap");
  assert.throws(() => parseCapXml(wrongNamespace), /CAP 1.2 namespace/i);
  const unrelatedNamespaceDeclaration = valid.replace(
    'xmlns="urn:oasis:names:tc:emergency:cap:1.2"',
    'xmlns="urn:example:not-cap" xmlns:unused="urn:oasis:names:tc:emergency:cap:1.2"'
  );
  assert.throws(() => parseCapXml(unrelatedNamespaceDeclaration), /CAP 1.2 namespace/i);
  const foreignNamespaceChild = valid.replace(
    "<event>Interop rainfall</event>",
    '<foreign:event xmlns:foreign="urn:example:not-cap">Interop rainfall</foreign:event>'
  );
  assert.throws(() => parseCapXml(foreignNamespaceChild), /CAP 1.2 namespace/i);
  const prefixedNamespace = valid
    .replace('xmlns="urn:oasis:names:tc:emergency:cap:1.2"', 'xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2"')
    .replace(/<(\/?)([A-Za-z][\w.-]*)(?=[\s/>])/g, (_match, slash, name) => `<${slash}cap:${name}`);
  const prefixed = parseCapXml(prefixedNamespace);
  assert.equal(prefixed.identifier, base.identifier, "prefixed CAP 1.2 elements must parse identically");
  const withDtd = '<!DOCTYPE alert [<!ENTITY x "blocked">]>' + valid;
  assert.throws(() => parseCapXml(withDtd), /DTD and entity declarations/i);
});

test("simulated external CAP receiver accepts exported XML and emits Ack reference", () => {
  // Local simulation only — no network and no external adapters.
  function simulatedExternalReceiver(xml) {
    const message = parseCapXml(xml);
    assert.equal(message.msg_type, "Alert");
    const ack = {
      identifier: makeIdentifier(),
      sender: "receiver@example.test",
      sent: new Date().toISOString(),
      status: "System",
      msg_type: "Ack",
      scope: "Public",
      references_text: `${message.sender},${message.identifier},${message.sent.replace(/\.\d{3}Z$/, "-00:00")}`
    };
    return { accepted: true, ackXml: buildCapXml(ack), ack };
  }

  const exported = buildCapXml(base);
  const result = simulatedExternalReceiver(exported);
  assert.equal(result.accepted, true);
  const ackParsed = parseCapXml(result.ackXml);
  assert.equal(ackParsed.msg_type, "Ack");
  assert.match(ackParsed.references_text, new RegExp(base.identifier));
});
