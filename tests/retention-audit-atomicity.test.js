import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { installAuditLogGuards, verifyAuditChain } from "../src/audit.js";
import { applyOperationalRetentionWithAudit } from "../src/retention.js";

function makeFixture() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE delivery_outbox(id INTEGER PRIMARY KEY, status TEXT, created_at TEXT, updated_at TEXT, delivered_at TEXT, dead_letter_at TEXT);
    CREATE TABLE webhook_inbox(id INTEGER PRIMARY KEY, received_at TEXT, status TEXT, reviewed_at TEXT);
    CREATE TABLE audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,alert_id INTEGER,action TEXT NOT NULL,details TEXT,created_at TEXT NOT NULL,previous_hash TEXT,entry_hash TEXT);
  `);
  installAuditLogGuards(db);
  db.prepare("INSERT INTO delivery_outbox(status,created_at,updated_at,delivered_at) VALUES ('delivered',datetime('now','-120 days'),datetime('now','-120 days'),datetime('now','-120 days'))").run();
  db.prepare("INSERT INTO webhook_inbox(received_at,status,reviewed_at) VALUES (datetime('now','-120 days'),'reviewed',datetime('now','-120 days'))").run();
  return db;
}

test("retention deletion and hash-chained audit event commit together", () => {
  const db = makeFixture();
  try {
    const result = applyOperationalRetentionWithAudit(db, { deliveryRetentionDays: 90, webhookRetentionDays: 90, userId: 7 });
    assert.equal(result.delivery.deleted, 1);
    assert.equal(result.webhook.deleted, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_outbox").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM webhook_inbox").get().n, 0);
    const audit = db.prepare("SELECT user_id,action,details,entry_hash FROM audit_log").get();
    assert.equal(audit.user_id, 7);
    assert.equal(audit.action, "retention_applied");
    assert.match(audit.details, /"deleted":1/);
    assert.match(audit.entry_hash, /^[a-f0-9]{64}$/);
    assert.equal(verifyAuditChain(db).valid, true);
  } finally { db.close(); }
});

test("audit persistence failure rolls back all retention deletions", () => {
  const db = makeFixture();
  try {
    db.exec(`
      CREATE TRIGGER reject_retention_audit
      BEFORE INSERT ON audit_log
      WHEN NEW.action='retention_applied'
      BEGIN
        SELECT RAISE(ABORT, 'simulated audit persistence failure');
      END;
    `);
    assert.throws(() => applyOperationalRetentionWithAudit(db, {
      deliveryRetentionDays: 90, webhookRetentionDays: 90, userId: 7
    }), /simulated audit persistence failure/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_outbox").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM webhook_inbox").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log").get().n, 0);
  } finally { db.close(); }
});

test("invalid retention parameters produce neither deletion nor audit success", () => {
  const db = makeFixture();
  try {
    assert.throws(() => applyOperationalRetentionWithAudit(db, {
      deliveryRetentionDays: 0, webhookRetentionDays: 90, userId: 7
    }), /between 1 and 3650 days/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_outbox").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM webhook_inbox").get().n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log").get().n, 0);
  } finally { db.close(); }
});
