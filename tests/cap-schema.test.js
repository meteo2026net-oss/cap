
test("CI requires the official CAP 1.2 schema and xmllint instead of silently skipping conformance tests", { skip: process.env.CI !== "true" }, () => {
  assert.ok(hasSchema, `Official OASIS CAP 1.2 schema was not found at ${schemaPath}`);
  assert.ok(hasXmllint, "xmllint is required in CI for CAP 1.2 XSD validation");
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildCapXml, makeIdentifier } from "../src/cap.js";

const schemaPath = process.env.CAP_XSD_PATH || path.resolve("schemas/CAP-v1.2.xsd");
const hasSchema = fs.existsSync(schemaPath);
const hasXmllint = spawnSync("xmllint", ["--version"], { encoding: "utf8" }).status === 0;

test("generated CAP XML conforms to the official OASIS CAP 1.2 XSD", { skip: !hasSchema || !hasXmllint }, () => {
  const xml = buildCapXml({
    identifier: makeIdentifier(),
    sender: "alerts@example.test",
    sent: "2026-11-04T05:00:00.000Z",
    status: "Test",
    msg_type: "Alert",
    scope: "Public",
    info_blocks: [
      {
        language: "en-GB",
        categories: ["Met"],
        event: "Heavy rainfall",
        urgency: "Expected",
        severity: "Moderate",
        certainty: "Likely",
        headline: "Heavy rain warning",
        description: "Heavy rain is possible.",
        areas: [{ areaDesc: "Test district", polygon: "51,0 52,0 52,1 51,1 51,0" }],
        resources: [{ resourceDesc: "Map", mimeType: "image/png", uri: "https://example.org/map.png" }]
      },
      {
        language: "ar",
        category: "Met",
        event: "أمطار غزيرة",
        urgency: "Expected",
        severity: "Moderate",
        certainty: "Likely",
        headline: "تحذير من أمطار غزيرة",
        description: "من المتوقع هطول أمطار غزيرة.",
        area: { areaDesc: "المنطقة", circle: "33.5,36.2 12" }
      }
    ]
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-xsd-"));
  const xmlPath = path.join(dir, "alert.xml");
  fs.writeFileSync(xmlPath, xml, "utf8");
  const result = spawnSync("xmllint", ["--noout", "--schema", schemaPath, xmlPath], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout || "xmllint schema validation failed");
  fs.rmSync(dir, { recursive: true, force: true });
});


test("all CAP message types conform to the official OASIS CAP 1.2 XSD", { skip: !hasSchema || !hasXmllint }, () => {
  const base = {
    sender: "alerts@example.test",
    sent: "2026-11-04T05:00:00.000Z",
    status: "Test",
    scope: "Public",
    info_blocks: [{
      language: "en-GB",
      categories: ["Met"],
      event: "Heavy rainfall",
      urgency: "Expected",
      severity: "Moderate",
      certainty: "Likely",
      headline: "Heavy rain warning",
      description: "Heavy rain is possible.",
      areas: [{ areaDesc: "Test district", polygon: "51,0 52,0 52,1 51,1 51,0" }]
    }]
  };
  const references = "alerts@example.test,urn:uuid:previous-id,2026-11-03T12:00:00-00:00";
  const cases = ["Alert", "Update", "Cancel", "Ack", "Error"].map(msg_type => ({
    msg_type,
    ...base,
    identifier: makeIdentifier(),
    ...(msg_type === "Alert" ? {} : { references_text: references }),
    ...(["Cancel", "Ack", "Error"].includes(msg_type) ? { info_blocks: undefined } : {})
  }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-xsd-matrix-"));
  try {
    for (const item of cases) {
      const xmlPath = path.join(dir, `${item.msg_type}.xml`);
      fs.writeFileSync(xmlPath, buildCapXml(item), "utf8");
      const result = spawnSync("xmllint", ["--noout", "--schema", schemaPath, xmlPath], { encoding: "utf8" });
      assert.equal(result.status, 0,
        `${item.msg_type} failed CAP 1.2 XSD validation: ${result.stderr || result.stdout}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("optional CAP metadata, response types, parameters, resources and area fields conform to the official XSD", { skip: !hasSchema || !hasXmllint }, () => {
  const xml = buildCapXml({
    identifier: makeIdentifier(),
    sender: "alerts@example.test",
    sent: "2026-11-05T05:00:00.000Z",
    status: "Test",
    msg_type: "Alert",
    source: "National Forecast Centre",
    scope: "Public",
    codes: ["profile:weather"],
    note: "Schema conformance fixture",
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
        derefUri: "ZW1iZWRkZWQtbWFw",
        digest: "qZk+NkcGgWq6PiVxeFDCbJzQ2J0="
      }]
    }]
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-xsd-optional-"));
  try {
    const xmlPath = path.join(dir, "optional-alert.xml");
    fs.writeFileSync(xmlPath, xml, "utf8");
    const result = spawnSync("xmllint", ["--noout", "--schema", schemaPath, xmlPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout || "optional CAP elements failed XSD validation");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CAP 1.2 XSD accepts escaped multilingual text and combined area/resource structures", { skip: !hasSchema || !hasXmllint }, () => {
  const xml = buildCapXml({
    identifier: makeIdentifier(),
    sender: "alerts@example.test",
    sent: "2026-11-06T05:00:00.000Z",
    status: "Exercise",
    msg_type: "Alert",
    scope: "Public",
    info_blocks: [{
      language: "ar",
      categories: ["Met", "Safety"],
      event: "أمطار ورياح & عواصف <تجريبية>",
      urgency: "Expected",
      severity: "Severe",
      certainty: "Likely",
      headline: "تحذير <تجريبي> & اختبار",
      description: "نص متعدد اللغات مع رموز XML: < > & \".",
      areas: [{
        areaDesc: "القطاع & المنطقة <أ>",
        polygons: ["51,0 52,0 52,1 51,1 51,0"],
        circles: ["33.5,36.2 12"],
        geocodes: [{ valueName: "LOCALITY", value: "D-001" }],
        altitude: 0,
        ceiling: 3000
      }],
      resources: [
        {
          resourceDesc: "خريطة & صورة <أ>",
          mimeType: "image/png",
          uri: "https://example.org/map.png",
          derefUri: "aGVsbG8="
        },
        {
          resourceDesc: "بيانات الطقس",
          mimeType: "application/json",
          size: 12,
          uri: "https://example.org/data.json"
        }
      ]
    }]
  });
  assert.match(xml, /&amp;/);
  assert.match(xml, /&lt;/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-xsd-escaped-"));
  try {
    const xmlPath = path.join(dir, "escaped-multilingual.xml");
    fs.writeFileSync(xmlPath, xml, "utf8");
    const result = spawnSync("xmllint", ["--noout", "--schema", schemaPath, xmlPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout || "multilingual CAP XML failed XSD validation");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
