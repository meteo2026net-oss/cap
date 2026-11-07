import { performance } from "node:perf_hooks";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { buildCapXml, makeIdentifier, parseCapXml, validateAlert } from "../../src/cap.js";

const COUNT = 10_000;
const root = await fs.mkdtemp(path.join(tmpdir(), "cap-perf-10k-"));
const databasePath = path.join(root, "cap-perf.sqlite");
process.env.DB_PATH = databasePath;

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  const percentile = p => sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)];
  return {
    count: sorted.length,
    avg_ms: Number((sum / sorted.length).toFixed(3)),
    median_ms: Number(percentile(50).toFixed(3)),
    p95_ms: Number(percentile(95).toFixed(3)),
    p99_ms: Number(percentile(99).toFixed(3)),
    max_ms: Number(sorted.at(-1).toFixed(3))
  };
}

function fixture(index) {
  return {
    identifier: makeIdentifier(),
    sender: "cap-perf@example.test",
    sent: new Date(Date.UTC(2026, 10, 7, 0, 0, index % 60)).toISOString(),
    status: "Test",
    msg_type: "Alert",
    scope: "Public",
    event: `Performance fixture ${index}`,
    category: "Met",
    urgency: "Expected",
    severity: "Moderate",
    certainty: "Likely",
    headline: `Synthetic warning ${index}`,
    description: `Performance harness message ${index}`,
    area_desc: `Test district ${index % 100}`,
    circle: "33.5,36.2 5",
    language: "en-US"
  };
}

try {
  const alerts = Array.from({ length: COUNT }, (_, index) => fixture(index));
  const validateTimes = [], buildTimes = [], parseTimes = [];
  const xmlDocuments = new Array(COUNT);

  const memoryBefore = process.memoryUsage();
  for (let i = 0; i < COUNT; i++) {
    let start = performance.now();
    if (validateAlert(alerts[i]) !== true) throw new Error(`Validation failed at ${i}`);
    validateTimes.push(performance.now() - start);

    start = performance.now();
    xmlDocuments[i] = buildCapXml(alerts[i]);
    buildTimes.push(performance.now() - start);

    start = performance.now();
    const parsed = parseCapXml(xmlDocuments[i]);
    parseTimes.push(performance.now() - start);
    if (parsed.identifier !== alerts[i].identifier) throw new Error(`XML round-trip identity mismatch at ${i}`);
  }

  const { db } = await import("../../src/db.js");
  try {
    const insert = db.prepare(`
      INSERT INTO alerts
        (identifier,sender,sent,status,msg_type,scope,event,category,urgency,severity,certainty,headline,description,area_desc,circle)
      VALUES
        (@identifier,@sender,@sent,@status,@msg_type,@scope,@event,@category,@urgency,@severity,@certainty,@headline,@description,@area_desc,@circle)
    `);
    const insertTransaction = db.transaction(rows => {
      for (const row of rows) insert.run(row);
    });
    const insertStart = performance.now();
    insertTransaction(alerts);
    const insertMs = performance.now() - insertStart;

    const read = db.prepare("SELECT id,identifier FROM alerts WHERE scope='Public' ORDER BY sent DESC LIMIT 100");
    const readTimes = [];
    for (let i = 0; i < 200; i++) {
      const start = performance.now();
      const rows = read.all();
      readTimes.push(performance.now() - start);
      if (!rows.length) throw new Error("Application-schema read returned no alerts");
    }

    const actualCount = db.prepare("SELECT COUNT(*) AS n FROM alerts").get().n;
    if (actualCount !== COUNT) throw new Error(`Expected ${COUNT} application alert rows, received ${actualCount}`);

    const report = {
      benchmark: "CAP 10,000-message local performance harness",
      dataset: "synthetic CAP messages processed through application CAP functions and actual src/db.js alerts schema",
      messages: COUNT,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: os.cpus()[0]?.model || "unknown"
      },
      cap: {
        validate: summarize(validateTimes),
        build_xml: summarize(buildTimes),
        parse_xml: summarize(parseTimes)
      },
      application_database: {
        inserted_rows: actualCount,
        insert_10000_ms: Number(insertMs.toFixed(3)),
        scoped_read_200: summarize(readTimes)
      },
      memory_bytes: {
        before: memoryBefore,
        after: process.memoryUsage()
      },
      limitations: [
        "Synthetic fixtures; not a production workload or a load test across HTTP clients.",
        "Single local process and local SQLite file; no network, disk contention, or external receiver latency is represented.",
        "Run on the target deployment host before using these figures for capacity planning."
      ]
    };
    console.log("CAP_PERF_10K_REPORT " + JSON.stringify(report));
  } finally {
    db.close();
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
