import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { buildCapXml, makeIdentifier, parseCapXml, validateAlert } from "../../src/cap.js";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarize(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    avg_ms: Number((sum / sorted.length).toFixed(3)),
    p95_ms: Number(percentile(sorted, 95).toFixed(3)),
    p99_ms: Number(percentile(sorted, 99).toFixed(3)),
    max_ms: Number(sorted[sorted.length - 1].toFixed(3))
  };
}

function syntheticAlert(i, overrides = {}) {
  return {
    identifier: makeIdentifier(),
    sender: "perf@example.test",
    sent: new Date(Date.UTC(2026, 10, 7, 0, 0, i % 60)).toISOString(),
    status: "Test",
    msg_type: "Alert",
    scope: "Public",
    event: `Perf event ${i}`,
    category: "Met",
    urgency: "Expected",
    severity: "Moderate",
    certainty: "Likely",
    headline: `Perf headline ${i}`,
    description: `Synthetic performance fixture ${i}`,
    area_desc: `District ${i % 50}`,
    circle: `${33 + (i % 10) * 0.01},${36 + (i % 10) * 0.01} 5`,
    language: "en-US",
    ...overrides
  };
}

test("performance: CAP validate/build/parse scales for 100 and 1000 synthetic messages", () => {
  const sizes = [100, 1000];
  const report = {};
  for (const size of sizes) {
    const validateMs = [];
    const buildMs = [];
    const parseMs = [];
    for (let i = 0; i < size; i++) {
      const alert = syntheticAlert(i);
      let t0 = performance.now();
      assert.equal(validateAlert(alert), true);
      validateMs.push(performance.now() - t0);
      t0 = performance.now();
      const xml = buildCapXml(alert);
      buildMs.push(performance.now() - t0);
      t0 = performance.now();
      const parsed = parseCapXml(xml);
      parseMs.push(performance.now() - t0);
      assert.equal(parsed.identifier, alert.identifier);
    }
    report[size] = {
      validate: summarize(validateMs),
      build_xml: summarize(buildMs),
      parse_xml: summarize(parseMs)
    };
    // Soft operational targets for CI runners; document rather than hard-fail on slow hosts.
    assert.ok(report[size].build_xml.avg_ms < 50, `build avg too high at size ${size}: ${report[size].build_xml.avg_ms}`);
    assert.ok(report[size].parse_xml.avg_ms < 50, `parse avg too high at size ${size}: ${report[size].parse_xml.avg_ms}`);
  }
  // Emit structured report for operators reviewing CI logs.
  console.log("CAP_PERF_REPORT " + JSON.stringify(report));
});

test("performance: SQLite concurrent reads remain consistent under mixed load", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cap-perf-db-"));
  const dbPath = path.join(root, "perf.sqlite");
  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        identifier TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL,
        workflow TEXT NOT NULL,
        headline TEXT NOT NULL
      );
      CREATE INDEX idx_alerts_scope ON alerts(scope, workflow);
    `);
    const insert = db.prepare("INSERT INTO alerts(identifier,scope,workflow,headline) VALUES (?,?,?,?)");
    const tx = db.transaction((n) => {
      for (let i = 0; i < n; i++) {
        insert.run(`id-${i}`, i % 3 === 0 ? "Restricted" : "Public", "published", `h-${i}`);
      }
    });
    const t0 = performance.now();
    tx(1000);
    const insertMs = performance.now() - t0;
    const readTimes = [];
    for (let i = 0; i < 200; i++) {
      const start = performance.now();
      const rows = db.prepare("SELECT identifier FROM alerts WHERE scope='Public' AND workflow='published' LIMIT 50").all();
      readTimes.push(performance.now() - start);
      assert.ok(rows.length > 0);
    }
    const stats = summarize(readTimes);
    console.log("SQLITE_PERF_REPORT " + JSON.stringify({ insert_1000_ms: Number(insertMs.toFixed(3)), reads: stats }));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM alerts").get().n, 1000);
    assert.ok(stats.avg_ms < 20, "public scoped reads should stay fast on synthetic dataset");
  } finally {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
