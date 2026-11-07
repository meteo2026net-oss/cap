import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createDatabaseBackup, runIsolatedRestoreDrill, verifyRestoredDatabase } from "../src/backup-utils.js";
import { appendAuditLog, initializeAuditCheckpoint } from "../src/audit.js";

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
  const backupBefore = await fs.readFile(backup);
  const sourceState = await verifyRestoredDatabase(backup);
  const result = await runIsolatedRestoreDrill(backup);
  const liveAfter = await fs.readFile(livePath);
  const backupAfter = await fs.readFile(backup);
  assert.deepEqual(liveAfter, liveBefore, "the live database must remain byte-for-byte unchanged");
  assert.deepEqual(backupAfter, backupBefore, "the source backup must remain byte-for-byte unchanged");
  assert.equal(result.result, "passed");
  assert.equal(result.integrity, "ok");
  assert.deepEqual(result.audit_checkpoint, {
    configured: false,
    valid: null,
    checkpoint_latest_id: null
  });
  assert.equal(result.temporary_workspace_removed, true);
  assert.deepEqual(result.counts, { users: 2, alerts: 1, audit_log: 2 });
  assert.equal(result.table_counts.alert_versions, 1);
  assert.deepEqual(result.table_fingerprints, sourceState.table_fingerprints,
    "the drill must reproduce every application table byte-content fingerprint");
  assert.equal(result.table_fingerprints.alert_versions.rows, 1);
  assert.match(result.table_fingerprints.alert_versions.sha256, /^[a-f0-9]{64}$/);
});


test("isolated restore drill verifies a configured external audit checkpoint", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cap-checkpoint-drill-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "source.sqlite");
  const database = new Database(dbPath);
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE alerts (id INTEGER PRIMARY KEY, identifier TEXT NOT NULL);
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY, user_id INTEGER, alert_id INTEGER,
      action TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL,
      previous_hash TEXT NOT NULL, entry_hash TEXT NOT NULL
    );
    INSERT INTO users(username) VALUES ('author');
    INSERT INTO alerts(identifier) VALUES ('CAP-CHECKPOINT-001');
  `);
  appendAuditLog(database, { action: "created", details: "checkpoint drill fixture" });
  appendAuditLog(database, { action: "submitted", details: "second event" });
  const backup = await createDatabaseBackup(database, path.join(root, "backups"));
  const checkpointPath = path.join(root, "independent-audit-anchor.json");
  const checkpointSecret = "test-only-checkpoint-secret-at-least-32-bytes";
  const anchor = initializeAuditCheckpoint(database, { checkpointPath, checkpointSecret });
  database.close();

  const checkpointBefore = await fs.readFile(checkpointPath);
  const result = await runIsolatedRestoreDrill(backup, {
    auditOptions: { checkpointPath, checkpointSecret }
  });
  const checkpointAfter = await fs.readFile(checkpointPath);
  assert.deepEqual(checkpointAfter, checkpointBefore, "the external checkpoint must remain byte-for-byte unchanged during an isolated drill");
  assert.equal(result.result, "passed");
  assert.deepEqual(result.audit_checkpoint, {
    configured: true,
    valid: true,
    checkpoint_latest_id: anchor.latest_id
  });
  assert.equal(result.audit.integrity_capabilities.external_checkpoint_configured, true);
  assert.equal(result.audit.integrity_capabilities.detects_final_tail_truncation, true);
});

test("restore drill rejects an external audit checkpoint signed with the wrong secret", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cap-checkpoint-invalid-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "source.sqlite");
  const database = new Database(dbPath);
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE alerts (id INTEGER PRIMARY KEY, identifier TEXT NOT NULL);
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY, user_id INTEGER, alert_id INTEGER,
      action TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL,
      previous_hash TEXT NOT NULL, entry_hash TEXT NOT NULL
    );
    INSERT INTO users(username) VALUES ('author');
    INSERT INTO alerts(identifier) VALUES ('CAP-CHECKPOINT-002');
  `);
  appendAuditLog(database, { action: "created", details: "invalid checkpoint fixture" });
  const backup = await createDatabaseBackup(database, path.join(root, "backups"));
  const checkpointPath = path.join(root, "independent-audit-anchor.json");
  initializeAuditCheckpoint(database, {
    checkpointPath,
    checkpointSecret: "correct-checkpoint-secret-with-32-bytes-minimum"
  });
  database.close();

  await assert.rejects(
    runIsolatedRestoreDrill(backup, {
      auditOptions: { checkpointPath, checkpointSecret: "incorrect-checkpoint-secret-with-32-bytes" }
    }),
    /Audit hash chain verification failed: checkpoint_signature_invalid/
  );
});


test("restore drill verifies CAP workflow counts and resolves internal message references", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cap-alert-state-drill-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dbPath = path.join(root, "source.sqlite");
  const database = new Database(dbPath);
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE alerts (
      id INTEGER PRIMARY KEY, identifier TEXT NOT NULL, sender TEXT NOT NULL, sent TEXT NOT NULL,
      status TEXT NOT NULL, msg_type TEXT NOT NULL, references_text TEXT, workflow TEXT NOT NULL
    );
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY, action TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO users(username) VALUES ('operator');
    INSERT INTO alerts(identifier,sender,sent,status,msg_type,references_text,workflow) VALUES
      ('CAP-ALERT-100','warnings@example.test','2026-11-06T00:00:00-00:00','Actual','Alert',NULL,'published'),
      ('CAP-UPDATE-101','warnings@example.test','2026-11-06T00:10:00-00:00','Actual','Update',
       'warnings@example.test,CAP-ALERT-100,2026-11-06T00:00:00-00:00','approved');
    INSERT INTO audit_log(action,created_at) VALUES ('created','2026-11-06T00:00:00.000Z');
  `);
  const backup = await createDatabaseBackup(database, path.join(root, "backups"));
  database.close();

  const result = await runIsolatedRestoreDrill(backup);
  assert.equal(result.result, "passed");
  assert.deepEqual(result.alert_state, {
    available: true,
    alert_count: 2,
    status_counts: { Actual: 2 },
    message_type_counts: { Alert: 1, Update: 1 },
    workflow_counts: { published: 1, approved: 1 },
    references: { total: 1, resolved_internal: 1, unresolved_external: 0 }
  });
});

test("backup validation rejects malformed CAP references before a restore drill", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cap-alert-state-invalid-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const database = new Database(path.join(root, "source.sqlite"));
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
    CREATE TABLE alerts (
      id INTEGER PRIMARY KEY, identifier TEXT NOT NULL, sender TEXT NOT NULL, sent TEXT NOT NULL,
      status TEXT NOT NULL, msg_type TEXT NOT NULL, references_text TEXT, workflow TEXT NOT NULL
    );
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY, action TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO alerts(identifier,sender,sent,status,msg_type,references_text,workflow)
    VALUES ('CAP-BAD-200','warnings@example.test','2026-11-06T00:00:00-00:00','Actual','Update','broken-reference','pending');
  `);
  await assert.rejects(
    createDatabaseBackup(database, path.join(root, "backups")),
    /malformed CAP reference/
  );
  database.close();
});

test("restore validation rejects impossible CAP calendar dates and timezone offsets", async t => {
  for (const [label, sent, references, msgType] of [
    ["alert date", "2026-02-30T00:00:00-00:00", null, "Alert"],
    ["reference date", "2026-11-06T00:00:00-00:00", "warnings@example.test,CAP-OLD-1,2026-02-30T00:00:00-00:00", "Update"],
    ["alert offset", "2026-11-06T00:00:00+14:01", null, "Alert"]
  ]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cap-invalid-calendar-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const database = new Database(path.join(root, "source.sqlite"));
    database.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT NOT NULL);
      CREATE TABLE alerts (
        id INTEGER PRIMARY KEY, identifier TEXT NOT NULL, sender TEXT NOT NULL, sent TEXT NOT NULL,
        status TEXT NOT NULL, msg_type TEXT NOT NULL, references_text TEXT, workflow TEXT NOT NULL
      );
      CREATE TABLE audit_log (id INTEGER PRIMARY KEY, action TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
    database.prepare(`
      INSERT INTO alerts(identifier,sender,sent,status,msg_type,references_text,workflow)
      VALUES (?,?,?,?,?,?,?)
    `).run("CAP-INVALID-" + label.replaceAll(" ", "-"), "warnings@example.test", sent, "Actual", msgType, references, "pending");
    await assert.rejects(
      createDatabaseBackup(database, path.join(root, "backups")),
      /invalid CAP sent timestamp|malformed CAP reference/
    );
    database.close();
  }
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
