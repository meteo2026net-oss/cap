import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendAuditLog, installAuditLogGuards } from "../src/audit.js";
import { createDatabaseBackup, pruneDatabaseBackups, restoreDatabaseBackup } from "../src/backup-utils.js";

function createFixtureDatabase(filePath) {
  const database = new Database(filePath);
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE alerts (id INTEGER PRIMARY KEY, identifier TEXT NOT NULL);
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY, user_id INTEGER, alert_id INTEGER,
      action TEXT NOT NULL, details TEXT, created_at TEXT NOT NULL,
      previous_hash TEXT, entry_hash TEXT
    );
  `);
  installAuditLogGuards(database);
  database.prepare("INSERT INTO users(username) VALUES ('backup-test')").run();
  database.prepare("INSERT INTO alerts(identifier) VALUES ('backup-alert')").run();
  appendAuditLog(database, { action: "backup_fixture_created" });
  return database;
}

test("SQLite backup is consistent and can be restored with hash-chain validation", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cap-backup-test-"));
  const source = path.join(directory, "source.sqlite");
  const restored = path.join(directory, "restored", "cap.sqlite");
  const database = createFixtureDatabase(source);
  try {
    const backup = await createDatabaseBackup(database, path.join(directory, "backups"), {
      now: new Date("2026-11-04T12:30:00.000Z")
    });
    assert.match(path.basename(backup), /^cap-20261104T123000Z\.sqlite$/);

    const result = await restoreDatabaseBackup(backup, restored);
    assert.equal(result.target, restored);
    const reopened = new Database(restored, { readonly: true });
    try {
      assert.equal(reopened.prepare("SELECT username FROM users").get().username, "backup-test");
      assert.equal(reopened.prepare("SELECT identifier FROM alerts").get().identifier, "backup-alert");
      assert.equal(reopened.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count, 1);
    } finally {
      reopened.close();
    }
  } finally {
    database.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("restore refuses overwrite without force and preserves the previous database on force", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cap-restore-test-"));
  const source = path.join(directory, "source.sqlite");
  const target = path.join(directory, "target.sqlite");
  const database = createFixtureDatabase(source);
  try {
    await fs.copyFile(source, target);
    await assert.rejects(() => restoreDatabaseBackup(source, target), /already exists/);
    const result = await restoreDatabaseBackup(source, target, { force: true });
    assert.equal(result.target, target);
    assert.ok(result.previous_database);
    await fs.access(result.previous_database);
  } finally {
    database.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("backup pruning removes only old CAP backup files", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cap-prune-test-"));
  try {
    const oldBackup = path.join(directory, "cap-20260101T000000Z.sqlite");
    const oldOther = path.join(directory, "other.sqlite");
    await fs.writeFile(oldBackup, "old");
    await fs.writeFile(oldOther, "keep");
    const oldDate = new Date("2026-01-01T00:00:00.000Z");
    await fs.utimes(oldBackup, oldDate, oldDate);
    const removed = await pruneDatabaseBackups(directory, {
      retentionDays: 30,
      now: new Date("2026-11-04T00:00:00.000Z")
    });
    assert.deepEqual(removed, ["cap-20260101T000000Z.sqlite"]);
    assert.equal(await fs.readFile(oldOther, "utf8"), "keep");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
