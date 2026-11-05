import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createDatabaseBackup } from "../src/backup-utils.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cap-backup-health-"));
  const db = new Database(path.join(root, "source.sqlite"));
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE alerts (id INTEGER PRIMARY KEY, identifier TEXT NOT NULL);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY, action TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO users(username) VALUES ('health');
    INSERT INTO alerts(identifier) VALUES ('health-alert');
    INSERT INTO audit_log(action, created_at) VALUES ('created', '2026-11-05T00:00:00.000Z');
  `);
  const dir = path.join(root, "backups");
  await fs.mkdir(dir);
  t.after(async () => { db.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, dir, db };
}

function run(dir, env = {}) {
  return spawnSync(process.execPath, ["src/backup-health.js", dir], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, BACKUP_MAX_AGE_HOURS: "26", ...env }
  });
}

test("backup:health reports missing backups with a non-zero exit", async t => {
  const { dir } = await fixture(t);
  const result = run(dir);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "missing");
});

test("backup:health accepts a recent verified backup", async t => {
  const { dir, db } = await fixture(t);
  await createDatabaseBackup(db, dir);
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "healthy");
});

test("backup:health flags a stale verified backup", async t => {
  const { dir, db } = await fixture(t);
  const file = await createDatabaseBackup(db, dir);
  const old = new Date(Date.now() - 48 * 3600000);
  await fs.utimes(file, old, old);
  await fs.utimes(file + ".sha256", old, old);
  const result = run(dir);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "stale");
});

test("backup:health flags a corrupt newest backup instead of silently using an older one", async t => {
  const { dir, db } = await fixture(t);
  await createDatabaseBackup(db, dir);
  const corrupt = path.join(dir, "cap-20261105T235959000Z-00000000-0000-4000-8000-000000000009.sqlite");
  await fs.writeFile(corrupt, "corrupt");
  const result = run(dir);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "invalid");
});
