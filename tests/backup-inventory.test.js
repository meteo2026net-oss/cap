import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createDatabaseBackup, listDatabaseBackups } from "../src/backup-utils.js";

test("backup inventory verifies generated files, reports corruption, and ignores unrelated files and symlinks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cap-backup-inventory-"));
  const databasePath = path.join(root, "source.sqlite");
  const backupDir = path.join(root, "backups");
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE alerts (id INTEGER PRIMARY KEY, identifier TEXT NOT NULL);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY, action TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO users(username) VALUES ('inventory');
    INSERT INTO alerts(identifier) VALUES ('inventory-alert');
    INSERT INTO audit_log(action, created_at) VALUES ('created', '2026-11-05T00:00:00.000Z');
  `);
  try {
    const valid = await createDatabaseBackup(database, backupDir);
    const invalid = path.join(backupDir, "cap-20261105T010101000Z-00000000-0000-4000-8000-000000000001.sqlite");
    await fs.copyFile(valid, invalid);
    await fs.writeFile(invalid, "tampered");
    await fs.writeFile(path.join(backupDir, "notes.txt"), "not a backup");
    await fs.symlink(valid, path.join(backupDir, "cap-20261105T010101000Z-00000000-0000-4000-8000-000000000002.sqlite"), "file");

    const items = await listDatabaseBackups(backupDir);
    assert.equal(items.length, 2);
    assert.equal(items.find(item => item.name === path.basename(valid)).verified, true);
    const bad = items.find(item => item.name === path.basename(invalid));
    assert.equal(bad.verified, false);
    assert.match(bad.error, /checksum|SQLite|manifest/i);
    assert.ok(items.every(item => Number.isInteger(item.size_bytes)));
  } finally {
    database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("backup inventory returns an empty list when the directory does not exist", async () => {
  const missing = path.join(os.tmpdir(), "cap-backup-inventory-missing-" + Date.now());
  assert.deepEqual(await listDatabaseBackups(missing), []);
});


test("backup:list CLI emits a machine-readable inventory for an explicit directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cap-backup-inventory-cli-"));
  try {
    const result = spawnSync(process.execPath, ["src/list-backups.js", root], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, BACKUP_DIR: "" }
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.directory, root);
    assert.equal(output.total, 0);
    assert.equal(output.verified, 0);
    assert.equal(output.invalid, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
