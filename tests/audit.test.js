import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { appendAuditLog, installAuditLogGuards, verifyAuditChain } from "../src/audit.js";

test("audit log records cannot be updated or deleted", () => {
  const database = new Database(":memory:");
  try {
    database.exec("CREATE TABLE audit_log (id INTEGER PRIMARY KEY, action TEXT NOT NULL)");
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

    database.exec("DROP TRIGGER audit_log_no_update");
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
    database.prepare("INSERT INTO audit_log(action,created_at) VALUES ('unhashed_tail','2026-11-04T12:00:00.000Z')").run();

    const result = verifyAuditChain(database);
    assert.equal(result.valid, false);
    assert.equal(result.reason, "unhashed_entry_after_chain");
    assert.equal(result.legacy_unhashed_entries, 1);
  } finally {
    database.close();
  }
});
