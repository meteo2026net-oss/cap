import test from "node:test";
import assert from "node:assert/strict";
import { buildCapXml, makeIdentifier, validateAlert } from "../src/cap.js";

const baseAlert = {
  identifier: "urn:uuid:semantic-base-alert",
  sender: "semantic@example.test",
  sent: "2026-11-07T10:00:00.000Z",
  status: "Test",
  msg_type: "Alert",
  scope: "Public",
  event: "Semantic rainfall",
  category: "Met",
  urgency: "Expected",
  severity: "Moderate",
  certainty: "Likely",
  headline: "Semantic CAP test warning",
  description: "Independent semantic validation fixture.",
  area_desc: "Semantic test district",
  circle: "33.5,36.2 10",
  language: "en-US"
};

const sourceReference = "semantic@example.test,urn:uuid:source-message,2026-11-07T09:00:00-00:00";

function derived(msg_type, overrides = {}) {
  return {
    ...baseAlert,
    identifier: makeIdentifier(),
    msg_type,
    references_text: sourceReference,
    ...overrides
  };
}

test("semantic: Alert requires core CAP header fields", () => {
  assert.equal(validateAlert(baseAlert), true);
  for (const field of ["identifier", "sender", "sent", "status", "msg_type", "scope"]) {
    const broken = { ...baseAlert, [field]: "" };
    assert.throws(() => validateAlert(broken), /required|Invalid CAP/i, `missing ${field} must fail`);
  }
});

test("semantic: Alert requires at least one info/area description path", () => {
  assert.throws(
    () => validateAlert({
      ...baseAlert,
      area_desc: "",
      circle: "",
      polygon: "",
      info_blocks: [{ language: "en", event: "Rain", urgency: "Expected", severity: "Minor", certainty: "Possible" }]
    }),
    /affected area|polygon, circle or geocode/i
  );
  assert.throws(
    () => validateAlert({
      ...baseAlert,
      msg_type: "Alert",
      info_blocks: []
    }),
    /require at least one info block/i
  );
});

test("semantic: enumerations reject values outside CAP 1.2 sets", () => {
  for (const [field, value] of [
    ["urgency", "Soon"],
    ["severity", "Critical"],
    ["certainty", "Confirmed"],
    ["status", "Draft"],
    ["msg_type", "Notify"],
    ["scope", "Internal"]
  ]) {
    assert.throws(() => validateAlert({ ...baseAlert, [field]: value }), /Invalid CAP/);
  }
});

test("semantic: date-time values require timezone and reject inverted onset/expiry", () => {
  assert.throws(() => validateAlert({ ...baseAlert, sent: "2026-11-07T10:00:00" }), /timezone|Invalid date/i);
  assert.throws(() => validateAlert({ ...baseAlert, onset: "not-a-date" }), /Invalid date/i);
  assert.throws(
    () => validateAlert({
      ...baseAlert,
      onset: "2026-11-07T12:00:00Z",
      expires: "2026-11-07T11:00:00Z"
    }),
    /Expiry must be later than onset/i
  );
  assert.equal(
    validateAlert({
      ...baseAlert,
      onset: "2026-11-07T11:00:00Z",
      expires: "2026-11-07T12:00:00Z"
    }),
    true
  );
});

test("semantic: Update Cancel Ack Error require well-formed references triplets", () => {
  for (const msg_type of ["Update", "Cancel", "Ack", "Error"]) {
    assert.throws(() => validateAlert({ ...baseAlert, msg_type, references_text: "" }), /must reference/i);
    assert.throws(
      () => validateAlert({ ...baseAlert, msg_type, references_text: "only-two,parts" }),
      /triplets/i
    );
    assert.throws(
      () => validateAlert({
        ...baseAlert,
        msg_type,
        references_text: "semantic@example.test,urn:uuid:x,2026-11-07T09:00:00"
      }),
      /timezone|timestamp/i
    );
    assert.equal(validateAlert(derived(msg_type)), true, `${msg_type} with valid reference must pass`);
  }
});

test("semantic: references preserve sender identifier sent components for derived types", () => {
  for (const msg_type of ["Update", "Cancel", "Ack", "Error"]) {
    const xml = buildCapXml(derived(msg_type));
    assert.match(xml, new RegExp(`<msgType>${msg_type}</msgType>`));
    assert.match(xml, /<references>semantic@example\.test,urn:uuid:source-message,2026-11-07T09:00:00-00:00<\/references>/);
    // CAP reference components must remain comma-separated and complete in XML output.
    const match = xml.match(/<references>([^<]+)<\/references>/);
    assert.ok(match, `${msg_type} must serialize references`);
    const [sender, identifier, sent] = match[1].trim().split(",");
    assert.equal(sender, "semantic@example.test");
    assert.equal(identifier, "urn:uuid:source-message");
    assert.equal(sent, "2026-11-07T09:00:00-00:00");
  }
});

test("semantic: Cancel Ack Error do not require info blocks while Update does", () => {
  for (const msg_type of ["Cancel", "Ack", "Error"]) {
    assert.equal(
      validateAlert({
        identifier: makeIdentifier(),
        sender: "semantic@example.test",
        sent: "2026-11-07T10:00:00.000Z",
        status: "Test",
        msg_type,
        scope: "Public",
        references_text: sourceReference
      }),
      true,
      `${msg_type} without info blocks must be valid`
    );
    const xml = buildCapXml({
      identifier: makeIdentifier(),
      sender: "semantic@example.test",
      sent: "2026-11-07T10:00:00.000Z",
      status: "Test",
      msg_type,
      scope: "Public",
      references_text: sourceReference
    });
    assert.doesNotMatch(xml, /<info>/);
  }

  assert.throws(
    () => validateAlert({
      identifier: makeIdentifier(),
      sender: "semantic@example.test",
      sent: "2026-11-07T10:00:00.000Z",
      status: "Test",
      msg_type: "Update",
      scope: "Public",
      references_text: sourceReference,
      info_blocks: []
    }),
    /requires an info block/i
  );
});

test("semantic: Restricted requires restriction and Private requires addresses", () => {
  assert.throws(() => validateAlert({ ...baseAlert, scope: "Restricted" }), /restriction/i);
  assert.throws(() => validateAlert({ ...baseAlert, scope: "Restricted", restriction: "   " }), /restriction/i);
  assert.equal(validateAlert({ ...baseAlert, scope: "Restricted", restriction: "Duty desk only" }), true);

  assert.throws(() => validateAlert({ ...baseAlert, scope: "Private" }), /addresses/i);
  assert.throws(() => validateAlert({ ...baseAlert, scope: "Private", addresses: "" }), /addresses/i);
  assert.equal(validateAlert({ ...baseAlert, scope: "Private", addresses: "ops@example.test" }), true);

  // Public must not require those fields.
  assert.equal(validateAlert({ ...baseAlert, scope: "Public", restriction: undefined, addresses: undefined }), true);
});

test("semantic: invalid messages are rejected before XML is produced", () => {
  const invalidCases = [
    { ...baseAlert, severity: "Critical" },
    { ...baseAlert, msg_type: "Update", references_text: "" },
    { ...baseAlert, scope: "Restricted" },
    { ...baseAlert, scope: "Private", addresses: " " },
    { ...baseAlert, msg_type: "Cancel", references_text: "bad-reference" },
    { ...baseAlert, identifier: "has space", sender: "semantic@example.test" }
  ];
  for (const invalid of invalidCases) {
    assert.throws(() => buildCapXml(invalid), /./, "buildCapXml must reject semantically invalid input");
  }
});

test("semantic: valid matrix of message types and scopes serializes expected CAP elements", () => {
  const matrix = [
    { msg_type: "Alert", scope: "Public" },
    { msg_type: "Alert", scope: "Restricted", restriction: "Internal only" },
    { msg_type: "Alert", scope: "Private", addresses: "ops@example.test" },
    { msg_type: "Update", scope: "Public", references_text: sourceReference },
    { msg_type: "Cancel", scope: "Restricted", restriction: "Internal only", references_text: sourceReference },
    { msg_type: "Ack", scope: "Public", references_text: sourceReference },
    { msg_type: "Error", scope: "Private", addresses: "ops@example.test", references_text: sourceReference }
  ];
  for (const item of matrix) {
    const payload = {
      ...baseAlert,
      identifier: makeIdentifier(),
      msg_type: item.msg_type,
      scope: item.scope,
      ...(item.restriction ? { restriction: item.restriction } : {}),
      ...(item.addresses ? { addresses: item.addresses } : {}),
      ...(item.references_text ? { references_text: item.references_text } : {}),
      // Cancel/Ack/Error: strip info path by clearing info-producing top-level event geometry only when needed
      ...(["Cancel", "Ack", "Error"].includes(item.msg_type)
        ? { event: "Semantic rainfall", headline: "Semantic CAP test warning", description: "Independent semantic validation fixture.", area_desc: "Semantic test district", circle: "33.5,36.2 10" }
        : {})
    };
    if (["Cancel", "Ack", "Error"].includes(item.msg_type)) {
      // Minimal header-only semantic object
      const minimal = {
        identifier: makeIdentifier(),
        sender: baseAlert.sender,
        sent: baseAlert.sent,
        status: "Test",
        msg_type: item.msg_type,
        scope: item.scope,
        references_text: item.references_text,
        ...(item.restriction ? { restriction: item.restriction } : {}),
        ...(item.addresses ? { addresses: item.addresses } : {})
      };
      const xml = buildCapXml(minimal);
      assert.match(xml, new RegExp(`<msgType>${item.msg_type}</msgType>`));
      assert.match(xml, new RegExp(`<scope>${item.scope}</scope>`));
      if (item.restriction) assert.match(xml, /<restriction>/);
      if (item.addresses) assert.match(xml, /<addresses>/);
      continue;
    }
    const xml = buildCapXml(payload);
    assert.match(xml, new RegExp(`<msgType>${item.msg_type}</msgType>`));
    assert.match(xml, new RegExp(`<scope>${item.scope}</scope>`));
    if (item.restriction) assert.match(xml, /<restriction>Internal only<\/restriction>/);
    if (item.addresses) assert.match(xml, /<addresses>ops@example\.test<\/addresses>/);
    if (item.references_text) assert.match(xml, /<references>/);
  }
});

test("semantic: multiple whitespace-separated references remain ordered and complete", () => {
  const references_text = [
    "semantic@example.test,urn:uuid:one,2026-11-07T08:00:00-00:00",
    "semantic@example.test,urn:uuid:two,2026-11-07T08:30:00-00:00"
  ].join(" ");
  const xml = buildCapXml(derived("Update", { references_text }));
  const match = xml.match(/<references>([^<]+)<\/references>/);
  assert.ok(match);
  const refs = match[1].trim().split(/\s+/);
  assert.equal(refs.length, 2);
  assert.equal(refs[0].split(",")[1], "urn:uuid:one");
  assert.equal(refs[1].split(",")[1], "urn:uuid:two");
});

test("semantic: derived references use the same normalized timestamp as the referenced alert", () => {
  const sourceSent = "2026-11-07T10:00:00+01:00";
  const sourceXml = buildCapXml({ ...baseAlert, sent: sourceSent });
  const normalizedSent = sourceXml.match(/<sent>([^<]+)<\/sent>/)?.[1];
  assert.equal(normalizedSent, "2026-11-07T09:00:00-00:00");

  for (const msg_type of ["Update", "Cancel", "Ack", "Error"]) {
    const derivedXml = buildCapXml({
      ...baseAlert,
      identifier: `urn:uuid:derived-${msg_type.toLowerCase()}`,
      sent: "2026-11-07T11:00:00Z",
      msg_type,
      references_text: `${baseAlert.sender},${baseAlert.identifier},${sourceSent}`
    });
    assert.match(derivedXml, new RegExp(`<references>${baseAlert.sender},${baseAlert.identifier},2026-11-07T09:00:00-00:00</references>`), msg_type);
  }
});
