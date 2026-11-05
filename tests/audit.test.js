import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { appendAuditLog, initializeAuditCheckpoint, installAuditLogGuards, verifyAuditChain } from "../src/audit.js";

test("audit log records cannot be updated or deleted", () => {
  const database = new Database(":memory:");
  try {
    database.exec("CREATE TABLE audit_log (id INTEGER PRIMARY KEY, action TEXT NOT NULL, entry_hash TEXT, previous_hash TEXT)");
    installAuditLogGuards(database);
    database.prepare("INSERT INTO audit_log(action) VALUES (?)").run("created");
    assert.throws(() => database.prepare("UPDATE audit_log SET action=? WHERE id=1").run("rewritten"), /append-only/);
    assert.throws(() => database.prepare("DELETE FROM audit_log WHERE id=1").run(), /append-only/);
    assert.equal(database.prepare("SELECT action FROM audit_log WHERE id=1").get().action, "created");
  } finally {
    database.close();
  }
});


test("audit hash chain verifies append order and detects modified entries", () => {
  const database = new Database(":memory:");
  try {
    database.exec(`
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        alert_id INTEGER,
        action TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL,
        previous_hash TEXT,
        entry_hash TEXT
      )
    `);
    installAuditLogGuards(database);

    const first = appendAuditLog(database, {
      userId: 7, alertId: 12, action: "created", details: "Draft created"
    });
    const second = appendAuditLog(database, {
      userId: 8, alertId: 12, action: "approved", details: "Independent review"
    });

    assert.equal(first.previous_hash, "0".repeat(64));
    assert.equal(second.previous_hash, first.entry_hash);
    assert.notEqual(first.entry_hash, second.entry_hash);

    const verified = verifyAuditChain(database);
    assert.equal(verified.valid, true);
    assert.equal(verified.verified_entries, 2);
    assert.equal(verified.legacy_unhashed_entries, 0);
    assert.deepEqual(verified.integrity_capabilities, {
      detects_entry_tampering: true,
      detects_internal_deletions: true,
      detects_final_tail_truncation: false,
      external_checkpoint_configured: false
    });

    database.exec("DROP TRIGGER audit_log_no_update");
    database.exec("DROP TRIGGER audit_log_no_unhashed_tail");
    database.prepare("UPDATE audit_log SET details=? WHERE id=?").run("tampered", first.id);

    const tampered = verifyAuditChain(database);
    assert.equal(tampered.valid, false);
    assert.equal(tampered.first_invalid_id, first.id);
    assert.equal(tampered.reason, "entry_hash_mismatch");
  } finally {
    database.close();
  }
});

test("legacy audit rows remain intact and are reported as unhashed", () => {
  const database = new Database(":memory:");
  try {
    database.exec(`
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        alert_id INTEGER,
        action TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL,
        previous_hash TEXT,
        entry_hash TEXT
      )
    `);
    database.prepare("INSERT INTO audit_log(id,action,created_at) VALUES (1,'legacy','2026-01-01T00:00:00.000Z')").run();
    installAuditLogGuards(database);
    const next = appendAuditLog(database, { action: "new_entry" });
    const status = verifyAuditChain(database);

    assert.equal(next.id, 2);
    assert.equal(status.valid, true);
    assert.equal(status.verified_entries, 1);
    assert.equal(status.legacy_unhashed_entries, 1);
    assert.equal(database.prepare("SELECT action FROM audit_log WHERE id=1").get().action, "legacy");
  } finally {
    database.close();
  }
});


test("audit verification flags unhashed records appended after hash-chain activation", () => {
  const database = new Database(":memory:");
  try {
    database.exec(`
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        alert_id INTEGER,
        action TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL,
        previous_hash TEXT,
        entry_hash TEXT
      )
    `);
    installAuditLogGuards(database);
    appendAuditLog(database, { action: "first_hashed_event" });
    database.exec("DROP TRIGGER audit_log_no_update");
    database.exec("DROP TRIGGER audit_log_no_unhashed_tail");
    database.prepare("INSERT INTO audit_log(action,created_at) VALUES ('unhashed_tail','2026-11-04T12:00:00.000Z')").run();

    const result = verifyAuditChain(database);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "unhashed_entry_after_chain");
    assert.equal(result.legacy_unhashed_entries, 1);
  } finally {
    database.close();
  }
});


test("audit log rejects unhashed inserts after hash-chain activation", () => {
  const database = new Database(":memory:");
  try {
    database.exec("CREATE TABLE audit_log (id INTEGER PRIMARY KEY,user_id INTEGER,alert_id INTEGER,action TEXT NOT NULL,details TEXT,created_at TEXT NOT NULL,previous_hash TEXT,entry_hash TEXT)");
    installAuditLogGuards(database);
    appendAuditLog(database, { action: "chain_started" });
    assert.throws(() => database.prepare("INSERT INTO audit_log(action,created_at) VALUES ('unhashed_tail','2026-11-04T12:00:00.000Z')").run(), /cannot accept unhashed entries/);
    assert.equal(verifyAuditChain(database).valid, true);
  } finally { database.close(); }
});


test("audit append rejects oversized action and details", () => {
  const database = new Database(":memory:");
  try {
    database.exec("CREATE TABLE audit_log (id INTEGER PRIMARY KEY,user_id INTEGER,alert_id INTEGER,action TEXT NOT NULL,details TEXT,created_at TEXT NOT NULL,previous_hash TEXT,entry_hash TEXT)");
    assert.throws(() => appendAuditLog(database, { action: "x".repeat(129) }), /128 characters/);
    assert.throws(() => appendAuditLog(database, { action: "ok", details: "x".repeat(4001) }), /4000 characters/);
  } finally { database.close(); }
});

test("audit hash chain detects a modified previous-hash link", () => {
  const database = new Database(":memory:");
  try {
    database.exec(`
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        alert_id INTEGER,
        action TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL,
        previous_hash TEXT,
        entry_hash TEXT
      )
    `);
    installAuditLogGuards(database);
    appendAuditLog(database, { action: "first_event" });
    const second = appendAuditLog(database, { action: "second_event" });

    database.exec("DROP TRIGGER audit_log_no_update");
    database.prepare("UPDATE audit_log SET previous_hash=? WHERE id=?")
      .run("f".repeat(64), second.id);

    const result = verifyAuditChain(database);
    assert.equal(result.valid, false);
    assert.equal(result.first_invalid_id, second.id);
    assert.equal(result.reason, "previous_hash_mismatch");
    assert.equal(result.verified_entries, 1);
  } finally {
    database.close();
  }
});



test("audit verification detects gaps between retained hashed entry IDs", () => {
  const database = new Database(":memory:");
  try {
    database.exec(`
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        alert_id INTEGER,
        action TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL,
        previous_hash TEXT,
        entry_hash TEXT
      )
    `);
    installAuditLogGuards(database);
    appendAuditLog(database, { action: "first_event" });
    appendAuditLog(database, { action: "second_event" });
    appendAuditLog(database, { action: "third_event" });

    database.exec("DROP TRIGGER audit_log_no_delete");
    database.prepare("DELETE FROM audit_log WHERE id=2").run();

    const result = verifyAuditChain(database);
    assert.equal(result.valid, false);
    assert.equal(result.first_invalid_id, 3);
    assert.equal(result.reason, "sequence_gap");
    assert.equal(result.verified_entries, 1);
  } finally {
    database.close();
  }
});

test("audit verification cannot detect deletion of the final retained entry without an external checkpoint", () => {
  const database = new Database(":memory:");
  try {
    database.exec(`
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY,
        user_id INTEGER,
        alert_id INTEGER,
        action TEXT NOT NULL,
        details TEXT,
        created_at TEXT NOT NULL,
        previous_hash TEXT,
        entry_hash TEXT
      )
    `);
    installAuditLogGuards(database);
    appendAuditLog(database, { action: "first_event" });
    appendAuditLog(database, { action: "second_event" });

    database.exec("DROP TRIGGER audit_log_no_delete");
    database.prepare("DELETE FROM audit_log WHERE id=2").run();

    const result = verifyAuditChain(database);
    assert.equal(result.valid, true);
    assert.equal(result.verified_entries, 1);
    assert.equal(result.integrity_capabilities.detects_final_tail_truncation, false);
    assert.equal(result.integrity_capabilities.external_checkpoint_configured, false);
  } finally {
    database.close();
  }
});


test("signed external audit checkpoint detects final tail truncation", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cap-audit-checkpoint-"));
  const checkpointPath = path.join(directory, "anchor.json");
  const checkpointSecret = "test-only-checkpoint-secret-at-least-32-bytes";
  const database = new Database(":memory:");
  try {
    database.exec("CREATE TABLE audit_log (id INTEGER PRIMARY KEY,user_id INTEGER,alert_id INTEGER,action TEXT NOT NULL,details TEXT,created_at TEXT NOT NULL,previous_hash TEXT,entry_hash TEXT)");
    installAuditLogGuards(database);
    appendAuditLog(database, { action: "first_event" }, { checkpointPath, checkpointSecret });
    appendAuditLog(database, { action: "second_event" }, { checkpointPath, checkpointSecret });
    const intact = verifyAuditChain(database, { checkpointPath, checkpointSecret });
    assert.equal(intact.valid, true);
    assert.equal(intact.integrity_capabilities.detects_final_tail_truncation, true);
    database.exec("DROP TRIGGER audit_log_no_delete");
    database.prepare("DELETE FROM audit_log WHERE id=2").run();
    const truncated = verifyAuditChain(database, { checkpointPath, checkpointSecret });
    assert.equal(truncated.valid, false);
    assert.equal(truncated.reason, "checkpoint_anchor_missing_or_changed");
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("external audit checkpoint detects unanchored append and forged signature", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cap-audit-checkpoint-"));
  const checkpointPath = path.join(directory, "anchor.json");
  const checkpointSecret = "test-only-checkpoint-secret-at-least-32-bytes";
  const database = new Database(":memory:");
  try {
    database.exec("CREATE TABLE audit_log (id INTEGER PRIMARY KEY,user_id INTEGER,alert_id INTEGER,action TEXT NOT NULL,details TEXT,created_at TEXT NOT NULL,previous_hash TEXT,entry_hash TEXT)");
    installAuditLogGuards(database);
    appendAuditLog(database, { action: "anchored" }, { checkpointPath, checkpointSecret });
    appendAuditLog(database, { action: "unanchored" });
    assert.equal(verifyAuditChain(database, { checkpointPath, checkpointSecret }).reason, "checkpoint_stale_or_database_rollback");
    const document = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
    document.signature = "0".repeat(64);
    fs.writeFileSync(checkpointPath, JSON.stringify(document));
    assert.equal(verifyAuditChain(database, { checkpointPath, checkpointSecret }).reason, "checkpoint_signature_invalid");
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test("checkpoint initialization anchors an existing verified chain once", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cap-audit-bootstrap-"));
  const checkpointPath = path.join(directory, "anchor.json");
  const checkpointSecret = "test-only-checkpoint-secret-at-least-32-bytes";
  const database = new Database(":memory:");
  try {
    database.exec("CREATE TABLE audit_log (id INTEGER PRIMARY KEY,user_id INTEGER,alert_id INTEGER,action TEXT NOT NULL,details TEXT,created_at TEXT NOT NULL,previous_hash TEXT,entry_hash TEXT)");
    installAuditLogGuards(database);
    appendAuditLog(database, { action: "legacy-chain-event" });
    const initialized = initializeAuditCheckpoint(database, { checkpointPath, checkpointSecret });
    assert.equal(initialized.latest_id, 1);
    assert.equal(verifyAuditChain(database, { checkpointPath, checkpointSecret }).valid, true);
    assert.throws(() => initializeAuditCheckpoint(database, { checkpointPath, checkpointSecret }), /already exists/);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
