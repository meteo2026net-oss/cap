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


test("rejects CAP messages without geographic geometry", () => {
  const { circle, ...withoutArea } = valid;
  assert.throws(() => validateAlert(withoutArea), /requires polygon, circle or geocode geometry/);
});

test("accepts the CAP 1.2 Draft status", () => {
  assert.equal(validateAlert({ ...valid, status: "Draft" }), true);
});

test("exports CAP 1.2 XML", () => {
  const xml = buildCapXml(valid);
  assert.match(xml, /urn:oasis:names:tc:emergency:cap:1\.2/);
  assert.match(xml, /<msgType>Alert<\/msgType>/);
  assert.match(xml, /<headline>Heavy rain warning<\/headline>/);
});

test("uses CAP numeric UTC offsets rather than the forbidden Z suffix", () => {
  const xml = buildCapXml(valid);
  assert.match(xml, /<sent>2026-11-04T00:00:00-00:00<\/sent>/);
  assert.doesNotMatch(xml, /<sent>[^<]*Z<\/sent>/);
});

test("exports multiple language info blocks with resources and geocodes", () => {
  const xml = buildCapXml({
    ...valid,
    info_blocks: [
      {
        language: "en-GB", category: "Met", event: "Heavy rainfall",
        urgency: "Expected", severity: "Moderate", certainty: "Likely",
        headline: "Heavy rain warning", description: "Heavy rain is possible.",
        areas: [{ areaDesc: "Central district", geocodes: [{ valueName: "SAME", value: "012345" }] }],
        resources: [{ resourceDesc: "Forecast map", mimeType: "image/png", uri: "https://example.org/map.png", size: 2048 }]
      },
      {
        language: "ar", category: "Met", event: "أمطار غزيرة",
        urgency: "Expected", severity: "Moderate", certainty: "Likely",
        headline: "تحذير من أمطار غزيرة", description: "من المتوقع هطول أمطار غزيرة.",
        area: { areaDesc: "المنطقة الوسطى", circle: "33.5,36.2 12" }
      }
    ]
  });
  assert.equal((xml.match(/<info>/g) || []).length, 2);
  assert.match(xml, /<language>ar<\/language>/);
  assert.match(xml, /<resourceDesc>Forecast map<\/resourceDesc>/);
  assert.match(xml, /<geocode>/);
  assert.match(xml, /<valueName>SAME<\/valueName>/);
});

test("creates CAP cancellation messages with references and no info block", () => {
  const xml = buildCapXml({
    ...valid, msg_type: "Cancel",
    references_text: "alerts@example.test,urn:uuid:previous-id,2026-11-03T12:00:00-00:00"
  });
  assert.match(xml, /<msgType>Cancel<\/msgType>/);
  assert.match(xml, /<references>/);
  assert.doesNotMatch(xml, /<info>/);
});

test("rejects resources missing mandatory description or MIME type", () => {
  assert.throws(() => buildCapXml({
    ...valid,
    info_blocks: [{
      language: "en-GB", category: "Met", event: "Heavy rainfall",
      urgency: "Expected", severity: "Moderate", certainty: "Likely",
      resources: [{ resourceDesc: "Map" }],
      area: { areaDesc: "Test district", circle: "51.5,-0.1 10" }
    }]
  }), /resourceDesc and mimeType/);
});

test("requires each warning language block to define a geographic area", () => {
  assert.throws(() => buildCapXml({
    ...valid,
    info_blocks: [{
      language: "en-GB", category: "Met", event: "Heavy rainfall",
      urgency: "Expected", severity: "Moderate", certainty: "Likely",
      headline: "Heavy rain warning", description: "Heavy rain is possible."
    }]
  }), /at least one affected area/);
});

test("exports update messages with a prior-message reference", () => {
  const xml = buildCapXml({
    ...valid, msg_type: "Update",
    references_text: "alerts@example.test,urn:uuid:previous-id,2026-11-03T12:00:00-00:00"
  });
  assert.match(xml, /<msgType>Update<\/msgType>/);
  assert.match(xml, /<references>/);
  assert.match(xml, /<info>/);
});

test("validates CAP language tags and headline length", () => {
  const base = {
    language: "en-GB", category: "Met", event: "Heavy rainfall",
    urgency: "Expected", severity: "Moderate", certainty: "Likely",
    area: { areaDesc: "Test district", circle: "51.5,-0.1 10" }
  };
  assert.throws(() => buildCapXml({ ...valid, info_blocks: [{ ...base, language: "bad_tag!" }] }), /language tag/);
  assert.throws(() => buildCapXml({ ...valid, info_blocks: [{ ...base, headline: "x".repeat(161) }] }), /160 characters/);
});

test("rejects invalid expiry windows and altitude ranges in info blocks", () => {
  const base = {
    language: "en-GB", category: "Met", event: "Heavy rainfall",
    urgency: "Expected", severity: "Moderate", certainty: "Likely",
    area: { areaDesc: "Test district", circle: "51.5,-0.1 10" }
  };
  assert.throws(() => buildCapXml({ ...valid, info_blocks: [{ ...base, onset: "2026-11-05T00:00:00Z", expires: "2026-11-04T00:00:00Z" }] }), /expiry must be later/);
  assert.throws(() => buildCapXml({ ...valid, info_blocks: [{ ...base, area: { areaDesc: "Test district", circle: "51.5,-0.1 10", altitude: 2000, ceiling: 1000 } }] }), /ceiling cannot be lower/);
});

test("requires references for CAP Update and Cancel messages", () => {
  assert.throws(() => buildCapXml({ ...valid, msg_type: "Cancel" }), /must reference the related message/);
  assert.throws(() => buildCapXml({ ...valid, msg_type: "Update" }), /must reference the related message/);
});
