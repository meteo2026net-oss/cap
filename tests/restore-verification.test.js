import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { verifyRestoredDatabase } from "../src/backup-utils.js";

async function makeDatabase(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cap-restored-check-"));
  const file = path.join(root, "restored.sqlite");
  const db = new Database(file);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE alerts (id INTEGER PRIMARY KEY, identifier TEXT NOT NULL);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY, action TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO users(username) VALUES ('operator-one'), ('operator-two');
    INSERT INTO alerts(identifier) VALUES ('CAP-001');
    INSERT INTO audit_log(action, created_at) VALUES ('restore-check', '2026-11-05T00:00:00.000Z');
  `);
  db.close();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, file };
}

test("post-restore verification reports SQLite integrity and core record counts", async t => {
  const { file } = await makeDatabase(t);
  const result = await verifyRestoredDatabase(file);
  assert.equal(result.integrity, "ok");
  assert.deepEqual(result.counts, { users: 2, alerts: 1, audit_log: 1 });
});

test("post-restore verification rejects missing database files", async t => {
  const { root } = await makeDatabase(t);
  await assert.rejects(verifyRestoredDatabase(path.join(root, "missing.sqlite")));
});

test("post-restore verification CLI prints a machine-readable report", async t => {
  const { file } = await makeDatabase(t);
  const result = spawnSync(process.execPath, ["src/verify-restored-db.js", file], {
    cwd: process.cwd(), encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.counts.users, 2);
  assert.equal(report.counts.alerts, 1);
});
