import test from "node:test";
import assert from "node:assert/strict";
import { buildCapXml, makeIdentifier, validateAlert } from "../src/cap.js";

const valid = {
  identifier: makeIdentifier(), sender: "alerts@example.test",
  sent: "2026-11-04T00:00:00.000Z", status: "Test", msg_type: "Alert", scope: "Public",
  event: "Heavy rainfall", category: "Met", urgency: "Expected", severity: "Moderate",
  certainty: "Likely", headline: "Heavy rain warning", description: "Heavy rain is possible.",
  area_desc: "Test district", circle: "51.5,-0.1 10", language: "en-GB"
};

test("creates unique CAP identifiers", () => {
  assert.match(makeIdentifier(), /^urn:uuid:[0-9a-f-]{36}$/i);
  assert.notEqual(makeIdentifier(), makeIdentifier());
});

test("accepts a valid minimal alert", () => assert.equal(validateAlert(valid), true));

test("rejects invalid CAP enumerations", () => {
  assert.throws(() => validateAlert({ ...valid, severity: "Critical" }), /Invalid CAP severity/);
});

test("rejects unclosed or malformed polygons", () => {
  assert.throws(() => validateAlert({ ...valid, polygon: "51,0 52,0 52,1 51,1" }), /must be closed/);
  assert.throws(() => validateAlert({ ...valid, polygon: "91,0 52,0 52,1 91,0" }), /valid latitude/);
});

test("accepts a closed polygon with whitespace separators", () => {
  assert.equal(validateAlert({ ...valid, polygon: "51,0 52,0 52,1 51,1 51,0" }), true);
});

test("validates circle coordinates and positive radius", () => {
  assert.equal(validateAlert({ ...valid, circle: "51.5,-0.1 10" }), true);
  assert.throws(() => validateAlert({ ...valid, circle: "51.5,-0.1 0" }), /circle/);
});

test("rejects invalid dates and expiry before onset", () => {
  assert.throws(() => validateAlert({ ...valid, onset: "not-a-date" }), /Invalid date/);
  assert.throws(() => validateAlert({ ...valid, onset: "2026-11-05T00:00:00Z", expires: "2026-11-04T00:00:00Z" }), /Expiry/);
});

test("exports CAP 1.2 XML", () => {
  const xml = buildCapXml(valid);
  assert.match(xml, /urn:oasis:names:tc:emergency:cap:1\.2/);
  assert.match(xml, /<msgType>Alert<\/msgType>/);
  assert.match(xml, /<headline>Heavy rain warning<\/headline>/);
});
