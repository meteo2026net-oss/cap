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

test("validates urgency, severity and certainty in every multilingual info block", () => {
  const block = {
    language: "en-GB", category: "Met", event: "Heavy rainfall",
    urgency: "Expected", severity: "Moderate", certainty: "Likely",
    area: { areaDesc: "District", circle: "51.5,-0.1 10" }
  };
  for (const [field, value] of [["urgency", "Immediate-ish"], ["severity", "Critical"], ["certainty", "Confirmed"]]) {
    assert.throws(() => buildCapXml({ ...valid, info_blocks: [{ ...block, [field]: value }] }),
      new RegExp(`Invalid CAP info ${field}`));
  }
  assert.equal(validateAlert({ ...valid, info_blocks: [block] }), true);
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
  assert.throws(() => validateAlert({ ...valid, onset: "2026-11-05T00:00:00Z", expires: "2026-11-04T00:00:00Z" }), /expiry/i);
});


test("rejects CAP messages without geographic geometry", () => {
  const { circle, ...withoutArea } = valid;
  assert.throws(() => validateAlert(withoutArea), /requires polygon, circle or geocode geometry/);
});

test("rejects Draft as a CAP status because draft is an internal workflow state", () => {
  assert.throws(() => validateAlert({ ...valid, status: "Draft" }), /Invalid CAP status/);
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

test("exports CAP Ack and Error messages with references and without info blocks", () => {
  const references = "alerts@example.test,urn:uuid:previous-id,2026-11-03T12:00:00-00:00";
  for (const msg_type of ["Ack", "Error"]) {
    const xml = buildCapXml({ ...valid, msg_type, references_text: references });
    assert.match(xml, new RegExp(`<msgType>${msg_type}</msgType>`));
    assert.match(xml, /<references>/);
    assert.doesNotMatch(xml, /<info>/);
    assert.throws(() => buildCapXml({ ...valid, msg_type }),
      /must reference the related message/);
  }
});


test("rejects blank and non-decimal CAP geometry coordinates", () => {
  for (const circle of [",36.2 12", "33.5, 36.2 12", "0x21,36.2 12", "33.5,36.2 0x10"]) {
    assert.throws(() => validateAlert({ ...valid, circle }), /circle/);
  }
  for (const polygon of ["51,0 52,0 52,1 51,1 ,0", "0x33,0 52,0 52,1 0x33,0"]) {
    assert.throws(() => validateAlert({ ...valid, polygon }), /coordinates/);
  }
});

test("closes CAP polygon rings by numeric coordinate equality", () => {
  assert.equal(validateAlert({ ...valid, polygon: "51.0,0 52,0 52,1 51,1 51,0.0" }), true);
});

test("counts CAP headline Unicode code points rather than UTF-16 code units", () => {
  const base = {
    language: "en-GB", category: "Met", event: "Heavy rainfall",
    urgency: "Expected", severity: "Moderate", certainty: "Likely",
    area: { areaDesc: "Test district", circle: "51.5,-0.1 10" }
  };
  assert.equal(validateAlert({ ...valid, info_blocks: [{ ...base, headline: "😀".repeat(80) + "x" }] }), true);
  assert.throws(() => validateAlert({ ...valid, info_blocks: [{ ...base, headline: "😀".repeat(161) }] }), /160 characters/);
});


test("validates CAP references as complete sender,identifier,sent triplets", () => {
  const references = [
    "alerts@example.test,urn:uuid:previous-one,2026-11-03T12:00:00-00:00",
    "alerts@example.test,urn:uuid:previous-two,2026-11-04T06:30:00Z"
  ].join(" ");
  const xml = buildCapXml({ ...valid, msg_type: "Update", references_text: references });
  assert.ok(xml.includes("<msgType>Update</msgType>"));
  assert.match(xml, /urn:uuid:previous-one/);
  assert.match(xml, /urn:uuid:previous-two/);
});

test("rejects incomplete CAP reference triplets and invalid referenced timestamps", () => {
  const invalidReferences = [
    "alerts@example.test,urn:uuid:only-two-fields",
    "alerts@example.test,,2026-11-03T12:00:00Z",
    "alerts@example.test,urn:uuid:missing-timezone,2026-11-03T12:00:00",
    "alerts@example.test,urn:uuid:invalid-date,2026-99-99T12:00:00Z",
    "alerts@example.test,urn:uuid:normalized-invalid-date,2026-02-30T12:00:00Z",
    "alerts@example.test,urn:uuid:bad-time,2026-11-03T25:61:00Z",
    "alerts@example.test,urn:uuid:bad-offset-hour,2026-11-03T12:00:00+24:00",
    "alerts@example.test,urn:uuid:bad-offset-minute,2026-11-03T12:00:00+02:60"
  ];
  for (const references_text of invalidReferences) {
    assert.throws(() => validateAlert({ ...valid, msg_type: "Update", references_text }),
      /CAP references|reference sent timestamp/);
  }
});

test("allows multiple CAP references separated by whitespace only", () => {
  const references_text = [
    "alerts@example.test,urn:uuid:one,2026-11-03T12:00:00-00:00",
    "alerts@example.test,urn:uuid:two,2026-11-04T12:00:00-00:00"
  ].join(" ");
  assert.equal(validateAlert({ ...valid, msg_type: "Cancel", references_text }), true);
});

test("accepts XML Schema maximum timezone offsets and rejects offsets beyond 14 hours", () => {
  const validReferences = [
    "alerts@example.test,urn:uuid:east-limit,2026-11-03T12:00:00+14:00",
    "alerts@example.test,urn:uuid:west-limit,2026-11-03T12:00:00-14:00"
  ].join(" ");
  assert.equal(validateAlert({ ...valid, msg_type: "Update", references_text: validReferences }), true);

  for (const sent of [
    "2026-11-03T12:00:00+14:01",
    "2026-11-03T12:00:00-14:30",
    "2026-11-03T12:00:00+15:00"
  ]) {
    const references_text = `alerts@example.test,urn:uuid:out-of-range,${sent}`;
    assert.throws(() => validateAlert({ ...valid, msg_type: "Update", references_text }),
      /out-of-range date, time or timezone offset/);
  }
});


test("serializes optional CAP metadata, response types, parameters and full area/resource fields", () => {
  const xml = buildCapXml({
    ...valid,
    source: "National Forecast Centre",
    codes: ["profile:weather", "region:west"],
    note: "Exercise message for integration testing",
    incidents: "INC-2026-0042",
    info_blocks: [{
      language: "en-GB",
      categories: ["Met", "Safety"],
      event: "Severe rainfall",
      response_types: ["Prepare", "Monitor"],
      urgency: "Expected",
      severity: "Severe",
      certainty: "Likely",
      effective: "2026-11-05T08:00:00+01:00",
      onset: "2026-11-05T09:00:00+01:00",
      expires: "2026-11-05T18:00:00+01:00",
      senderName: "Forecast Operations",
      headline: "Heavy rainfall expected",
      description: "Periods of heavy rainfall are expected.",
      instruction: "Monitor official updates.",
      web: "https://example.org/warnings",
      contact: "forecast@example.org",
      parameters: [{ valueName: "rainfall_mm", value: "35" }],
      areas: [{
        areaDesc: "Western district",
        polygon: "51,0 52,0 52,1 51,1 51,0",
        altitude: 0,
        ceiling: 2500
      }],
      resources: [{
        resourceDesc: "Rainfall map",
        mimeType: "image/png",
        size: 4096,
        uri: "https://example.org/rain.png",
        derefUri: "embedded-map",
        digest: "0123456789abcdef"
      }]
    }]
  });
  for (const tag of [
    "source", "code", "note", "incidents", "responseType", "effective", "onset", "expires",
    "senderName", "instruction", "web", "contact", "parameter", "valueName", "altitude",
    "ceiling", "derefUri", "digest"
  ]) assert.match(xml, new RegExp(`<${tag}>`));
  assert.match(xml, /<category>Safety<\/category>/);
  assert.match(xml, /<responseType>Prepare<\/responseType>/);
  assert.match(xml, /<value>35<\/value>/);
  assert.match(xml, /<size>4096<\/size>/);
});

test("rejects invalid CAP categories and response types", () => {
  const block = {
    language: "en-GB", event: "Heavy rainfall",
    urgency: "Expected", severity: "Moderate", certainty: "Likely",
    area: { areaDesc: "District", circle: "51.5,-0.1 10" }
  };
  assert.throws(() => buildCapXml({ ...valid, info_blocks: [{ ...block, category: "Weather" }] }), /valid category/);
  assert.throws(() => buildCapXml({ ...valid, info_blocks: [{ ...block, response_type: "RunAway" }] }), /responseType/);
});
