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
