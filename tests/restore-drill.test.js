import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createDatabaseBackup, runIsolatedRestoreDrill, verifyRestoredDatabase } from "../src/backup-utils.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cap-restore-drill-test-"));
  const dbPath = path.join(root, "source.sqlite");
  const database = new Database(dbPath);
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE alerts (id INTEGER PRIMARY KEY, identifier TEXT NOT NULL);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY, action TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE alert_versions (id INTEGER PRIMARY KEY, alert_id INTEGER NOT NULL, snapshot TEXT NOT NULL);
    INSERT INTO users(username) VALUES ('author'), ('reviewer');
    INSERT INTO alerts(identifier) VALUES ('CAP-DRILL-001');
    INSERT INTO audit_log(action, created_at) VALUES
      ('created', '2026-11-05T00:00:00.000Z'),
      ('submitted', '2026-11-05T00:01:00.000Z');
    INSERT INTO alert_versions(alert_id, snapshot) VALUES (1, '{"severity":"Severe"}');
  `);
  const backupDir = path.join(root, "backups");
  const backup = await createDatabaseBackup(database, backupDir);
  database.close();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, dbPath, backup };
}

test("isolated restore drill runs the real restore path and compares every table count", async t => {
  const { root, backup } = await fixture(t);
  const livePath = path.join(root, "live-database.sqlite");
  const liveDb = new Database(livePath);
  liveDb.exec("CREATE TABLE live_sentinel (value TEXT); INSERT INTO live_sentinel VALUES ('must-not-change');");
  liveDb.close();
  const liveBefore = await fs.readFile(livePath);
  const sourceState = await verifyRestoredDatabase(backup);
  const result = await runIsolatedRestoreDrill(backup);
  const liveAfter = await fs.readFile(livePath);
  assert.deepEqual(liveAfter, liveBefore, "the live database must remain byte-for-byte unchanged");
  assert.equal(result.result, "passed");
  assert.equal(result.integrity, "ok");
  assert.equal(result.temporary_workspace_removed, true);
  assert.deepEqual(result.counts, { users: 2, alerts: 1, audit_log: 2 });
  assert.equal(result.table_counts.alert_versions, 1);
  assert.deepEqual(result.table_fingerprints, sourceState.table_fingerprints,
    "the drill must reproduce every application table byte-content fingerprint");
  assert.equal(result.table_fingerprints.alert_versions.rows, 1);
  assert.match(result.table_fingerprints.alert_versions.sha256, /^[a-f0-9]{64}$/);
});

test("isolated restore drill rejects a backup whose checksum was changed", async t => {
  const { backup } = await fixture(t);
  await fs.writeFile(backup, "tampered");
  await assert.rejects(runIsolatedRestoreDrill(backup), /checksum|SQLite|integrity/i);
});

test("restore:drill CLI prints a successful machine-readable report", async t => {
  const { backup } = await fixture(t);
  const result = spawnSync(process.execPath, ["src/restore-drill.js", backup], {
    cwd: process.cwd(), encoding: "utf8", timeout: 30000
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.result, "passed");
  assert.equal(report.temporary_workspace_removed, true);
  assert.equal(report.counts.users, 2);
  assert.match(report.table_fingerprints.users.sha256, /^[a-f0-9]{64}$/);
});
