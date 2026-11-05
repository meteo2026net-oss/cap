import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendAuditLog, installAuditLogGuards } from "../src/audit.js";
import { createDatabaseBackup, pruneDatabaseBackups, restoreDatabaseBackup, verifyDatabaseBackup } from "../src/backup-utils.js";

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
    assert.match(path.basename(backup), /^cap-20261104T123000\d{3}Z-[0-9a-f-]{36}\.sqlite$/);
    assert.equal((await fs.stat(backup)).mode & 0o777, 0o600,
      "backup files must be owner-readable and owner-writable only");
    const sameSecondBackup = await createDatabaseBackup(database, path.join(directory, "backups"), {
      now: new Date("2026-11-04T12:30:00.500Z")
    });
    assert.notEqual(backup, sameSecondBackup, "backups created within the same second must not collide");
    const sameMillisecondBackup = await createDatabaseBackup(database, path.join(directory, "backups"), {
      now: new Date("2026-11-04T12:30:00.000Z")
    });
    assert.notEqual(backup, sameMillisecondBackup,
      "backups created at the exact same millisecond must have unique filenames");

    const result = await restoreDatabaseBackup(backup, restored);
    assert.equal(result.target, restored);
    assert.equal((await fs.stat(restored)).mode & 0o777, 0o600,
      "restored database files must be owner-readable and owner-writable only");
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
    assert.match(result.previous_database, /\.pre-restore-\d{8}T\d{6}\d{3}Z-[0-9a-f-]{36}$/);
    await fs.access(result.previous_database);
  } finally {
    database.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("restore restores the original database when installing the replacement fails", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cap-restore-install-failure-"));
  const source = path.join(directory, "source.sqlite");
  const target = path.join(directory, "target.sqlite");
  const database = createFixtureDatabase(source);
  let renameCalls = 0;
  const fileSystem = {
    rename: async (from, to) => {
      renameCalls++;
      if (renameCalls === 2) throw new Error("simulated replacement rename failure");
      return fs.rename(from, to);
    }
  };
  try {
    await fs.copyFile(source, target);
    await assert.rejects(
      () => restoreDatabaseBackup(source, target, { force: true, fileSystem }),
      /simulated replacement rename failure/
    );
    const restoredOriginal = new Database(target, { readonly: true });
    try {
      assert.equal(restoredOriginal.prepare("SELECT username FROM users").get().username, "backup-test");
    } finally {
      restoredOriginal.close();
    }
    assert.equal((await fs.readdir(directory)).some(name => name.includes(".pre-restore-")), false,
      "successfully restored rollback file should be moved back to the target");
    assert.equal((await fs.readdir(directory)).some(name => name.includes(".restore-")), false,
      "failed temporary replacement should be removed");
  } finally {
    database.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("restore reports and preserves rollback file if rollback rename also fails", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cap-restore-rollback-failure-"));
  const source = path.join(directory, "source.sqlite");
  const target = path.join(directory, "target.sqlite");
  const database = createFixtureDatabase(source);
  let renameCalls = 0;
  const fileSystem = {
    rename: async (from, to) => {
      renameCalls++;
      if (renameCalls >= 2) throw new Error("simulated rename failure " + renameCalls);
      return fs.rename(from, to);
    }
  };
  try {
    await fs.copyFile(source, target);
    await assert.rejects(
      () => restoreDatabaseBackup(source, target, { force: true, fileSystem }),
      error => error instanceof AggregateError &&
        /preserved rollback file is:/.test(error.message) &&
        error.errors.length === 2
    );
    const rollback = (await fs.readdir(directory)).find(name => name.includes(".pre-restore-"));
    assert.ok(rollback, "previous database must remain available at the reported rollback path");
    const preserved = new Database(path.join(directory, rollback), { readonly: true });
    try {
      assert.equal(preserved.prepare("SELECT username FROM users").get().username, "backup-test");
    } finally {
      preserved.close();
    }
  } finally {
    database.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("backup pruning removes only old CAP backup files", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cap-prune-test-"));
  try {
    const oldBackup = path.join(directory, "cap-20260101T000000000Z.sqlite");
    const oldUniqueBackup = path.join(directory, "cap-20260101T000000000Z-00000000-0000-4000-8000-000000000000.sqlite");
    const oldOther = path.join(directory, "other.sqlite");
    await fs.writeFile(oldBackup, "old");
    await fs.writeFile(oldUniqueBackup, "old unique");
    await fs.writeFile(oldOther, "keep");
    const oldDate = new Date("2026-01-01T00:00:00.000Z");
    await fs.utimes(oldBackup, oldDate, oldDate);
    await fs.utimes(oldUniqueBackup, oldDate, oldDate);
    const removed = await pruneDatabaseBackups(directory, {
      retentionDays: 30,
      now: new Date("2026-11-04T00:00:00.000Z")
    });
    assert.deepEqual(removed, [
      "cap-20260101T000000000Z-00000000-0000-4000-8000-000000000000.sqlite",
      "cap-20260101T000000000Z.sqlite"
    ]);
    assert.equal(await fs.readFile(oldOther, "utf8"), "keep");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("backup and restore reject a database with a broken audit hash chain", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cap-corrupt-backup-test-"));
  const source = path.join(directory, "source.sqlite");
  const database = createFixtureDatabase(source);
  try {
    database.exec("DROP TRIGGER audit_log_no_update");
    database.prepare("UPDATE audit_log SET details='tampered' WHERE id=1").run();
    await assert.rejects(
      () => createDatabaseBackup(database, path.join(directory, "backups")),
      /Audit hash chain verification failed/
    );
    assert.deepEqual(await fs.readdir(path.join(directory, "backups")), [],
      "an invalid backup artifact must be removed after validation fails");
    await assert.rejects(
      () => restoreDatabaseBackup(source, path.join(directory, "restored.sqlite")),
      /Audit hash chain verification failed/
    );
  } finally {
    database.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("backup and restore reject databases with foreign-key violations", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cap-foreign-key-backup-test-"));
  const source = path.join(directory, "source.sqlite");
  const database = createFixtureDatabase(source);
  try {
    database.exec("CREATE TABLE child_records (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id))");
    database.pragma("foreign_keys = OFF");
    database.prepare("INSERT INTO child_records(user_id) VALUES (999999)").run();
    await assert.rejects(
      () => createDatabaseBackup(database, path.join(directory, "backups")),
      /foreign_key_check failed/
    );
    await assert.rejects(
      () => restoreDatabaseBackup(source, path.join(directory, "restored.sqlite")),
      /foreign_key_check failed/
    );
  } finally {
    database.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("restore refuses to proceed while SQLite WAL or SHM sidecars exist", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cap-restore-sidecar-test-"));
  const source = path.join(directory, "source.sqlite");
  const target = path.join(directory, "target.sqlite");
  const database = createFixtureDatabase(source);
  try {
    await fs.writeFile(target + "-wal", "active sidecar");
    await assert.rejects(
      () => restoreDatabaseBackup(source, target),
      /WAL\/SHM sidecar exists/
    );
    await fs.rm(target + "-wal", { force: true });
    await fs.writeFile(target + "-shm", "active sidecar");
    await assert.rejects(
      () => restoreDatabaseBackup(source, target),
      /WAL\/SHM sidecar exists/
    );
  } finally {
    database.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("backup retention rejects invalid retention windows", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cap-retention-test-"));
  try {
    await assert.rejects(() => pruneDatabaseBackups(directory, { retentionDays: 0 }), /at least one day/);
    await assert.rejects(() => pruneDatabaseBackups(directory, { retentionDays: Number.NaN }), /at least one day/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test("failed SQLite backup removes a partially created artifact", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cap-partial-backup-test-"));
  const destination = path.join(directory, "backups");
  const database = {
    async backup(filePath) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "incomplete SQLite backup");
      throw new Error("simulated backup interruption");
    }
  };
  try {
    await assert.rejects(
      () => createDatabaseBackup(database, destination, { now: new Date("2026-11-04T12:30:00.000Z") }),
      /simulated backup interruption/
    );
    assert.deepEqual(await fs.readdir(destination), [],
      "a partially written backup must be removed after backup() fails");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test("backup pruning never follows or removes symbolic links", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cap-prune-symlink-test-"));
  const external = path.join(directory, "external.sqlite");
  const link = path.join(directory, "cap-20260101T000000000Z.sqlite");
  try {
    await fs.writeFile(external, "keep external target");
    const oldDate = new Date("2026-01-01T00:00:00.000Z");
    await fs.utimes(external, oldDate, oldDate);
    await fs.symlink(external, link, "file");
    const removed = await pruneDatabaseBackups(directory, {
      retentionDays: 30,
      now: new Date("2026-11-04T00:00:00.000Z")
    });
    assert.deepEqual(removed, []);
    assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
    assert.equal(await fs.readFile(external, "utf8"), "keep external target");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("restore rejects symbolic-link backup sources", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cap-restore-symlink-test-"));
  const source = path.join(directory, "source.sqlite");
  const link = path.join(directory, "backup-link.sqlite");
  const database = createFixtureDatabase(source);
  try {
    await fs.symlink(source, link, "file");
    await assert.rejects(
      () => restoreDatabaseBackup(link, path.join(directory, "restored.sqlite")),
      /regular file, not a symbolic link/
    );
  } finally {
    database.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test("restore refuses symbolic-link targets without moving or replacing the link", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cap-restore-target-symlink-"));
  const source = path.join(directory, "source.sqlite");
  const target = path.join(directory, "target.sqlite");
  const external = path.join(directory, "external.sqlite");
  const database = createFixtureDatabase(source);
  try {
    await fs.writeFile(external, "keep external target");
    await fs.symlink(external, target, "file");
    await assert.rejects(
      () => restoreDatabaseBackup(source, target, { force: true }),
      /Restore target must be a regular file/
    );
    assert.equal((await fs.lstat(target)).isSymbolicLink(), true);
    assert.equal(await fs.readFile(external, "utf8"), "keep external target");
  } finally {
    database.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("restore detects dangling WAL and SHM symlinks", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cap-restore-dangling-sidecar-"));
  const source = path.join(directory, "source.sqlite");
  const target = path.join(directory, "target.sqlite");
  const database = createFixtureDatabase(source);
  try {
    await fs.symlink(path.join(directory, "missing-wal-target"), target + "-wal", "file");
    await assert.rejects(
      () => restoreDatabaseBackup(source, target),
      /WAL\/SHM sidecar exists/
    );
    await fs.rm(target + "-wal");
    await fs.symlink(path.join(directory, "missing-shm-target"), target + "-shm", "file");
    await assert.rejects(
      () => restoreDatabaseBackup(source, target),
      /WAL\/SHM sidecar exists/
    );
  } finally {
    database.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});


test("new backups include SHA-256 manifests and restore verifies them", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cap-backup-checksum-"));
  const source = path.join(directory, "source.sqlite");
  const database = createFixtureDatabase(source);
  try {
    const backup = await createDatabaseBackup(database, path.join(directory, "backups"));
    const manifestPath = `${backup}.sha256`;
    assert.match(await fs.readFile(manifestPath, "utf8"), /^[a-f0-9]{64}  cap-.*\.sqlite\n$/);
    assert.equal((await fs.stat(manifestPath)).mode & 0o777, 0o600);
    await restoreDatabaseBackup(backup, path.join(directory, "restored.sqlite"));
  } finally { database.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("backup verification reports checksum, SQLite integrity, and audit-chain status", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cap-backup-verify-"));
  const source = path.join(directory, "source.sqlite");
  const database = createFixtureDatabase(source);
  try {
    const backup = await createDatabaseBackup(database, path.join(directory, "backups"));
    const result = await verifyDatabaseBackup(backup);
    assert.equal(result.checksum, "verified");
    assert.equal(result.integrity, "ok");
    assert.equal(result.audit.valid, true);
    await fs.appendFile(backup, Buffer.from("tampered"));
    await assert.rejects(() => verifyDatabaseBackup(backup), /SHA-256 checksum verification failed/);
  } finally {
    database.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("restore rejects modified backup bytes before replacing the target", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cap-backup-tamper-"));
  const source = path.join(directory, "source.sqlite");
  const target = path.join(directory, "target.sqlite");
  const database = createFixtureDatabase(source);
  try {
    const backup = await createDatabaseBackup(database, path.join(directory, "backups"));
    await fs.copyFile(source, target);
    await fs.appendFile(backup, Buffer.from("tampered"));
    await assert.rejects(() => restoreDatabaseBackup(backup, target, { force: true }), /SHA-256 checksum verification failed/);
    const untouched = new Database(target, { readonly: true });
    try { assert.equal(untouched.prepare("SELECT username FROM users").get().username, "backup-test"); }
    finally { untouched.close(); }
  } finally { database.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("restore rejects a missing checksum manifest for a new-format backup", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cap-backup-manifest-missing-"));
  const source = path.join(directory, "source.sqlite");
  const database = createFixtureDatabase(source);
  try {
    const backup = await createDatabaseBackup(database, path.join(directory, "backups"));
    await fs.rm(`${backup}.sha256`);
    await assert.rejects(() => restoreDatabaseBackup(backup, path.join(directory, "restored.sqlite")), /ENOENT/);
  } finally { database.close(); await fs.rm(directory, { recursive: true, force: true }); }
});


test("restore rejects a symbolic-link checksum manifest", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cap-backup-manifest-link-"));
  const source = path.join(directory, "source.sqlite");
  const database = createFixtureDatabase(source);
  try {
    const backup = await createDatabaseBackup(database, path.join(directory, "backups"));
    const manifest = `${backup}.sha256`;
    const external = path.join(directory, "external-manifest");
    await fs.rename(manifest, external);
    await fs.symlink(external, manifest, "file");
    await assert.rejects(
      () => restoreDatabaseBackup(backup, path.join(directory, "restored.sqlite")),
      /manifest must be a regular file/
    );
  } finally {
    database.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
