import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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

test("external checkpoint refresh occurs after commit and reports filesystem failure", () => {
  const db = makeFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-retention-checkpoint-"));
  const blocker = path.join(root, "not-a-directory");
  fs.writeFileSync(blocker, "file");
  try {
    const result = applyOperationalRetentionWithAudit(db, {
      deliveryRetentionDays: 90,
      webhookRetentionDays: 90,
      userId: 7,
      auditOptions: {
        checkpointPath: path.join(blocker, "checkpoint.json"),
        checkpointSecret: "x".repeat(32)
      }
    });
    assert.equal(result.ok, true);
    assert.match(result.audit_checkpoint_warning, /database audit event committed/i);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_outbox").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM webhook_inbox").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='retention_applied'").get().n, 1);
    assert.equal(verifyAuditChain(db).valid, true);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retention CLI records its system audit event through the atomic path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-retention-cli-"));
  const databasePath = path.join(root, "cap.sqlite");
  const env = {
    ...process.env,
    DB_PATH: databasePath,
    CAP_DELIVERY_RETENTION_DAYS: "90",
    CAP_WEBHOOK_RETENTION_DAYS: "90"
  };
  const bootstrap = [
    "const { db } = await import('./src/db.js');",
    "const alert = db.prepare(\"INSERT INTO alerts (identifier,sender,sent,status,msg_type,scope,event,category,urgency,severity,certainty,headline,description,area_desc) VALUES ('urn:uuid:retention-cli-test','cli@example.test','2026-11-07T00:00:00.000-00:00','Test','Alert','Public','Retention test','Met','Expected','Minor','Likely','Retention test','CLI retention fixture','Test area')\").run();",
    "db.prepare(\"INSERT INTO delivery_outbox(alert_id,channel,payload,status,created_at,updated_at,delivered_at) VALUES (?,'cap_feed','{}','delivered',datetime('now','-120 days'),datetime('now','-120 days'),datetime('now','-120 days'))\").run(alert.lastInsertRowid);",
    "db.close();"
  ].join("\n");
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", bootstrap], {
      cwd: process.cwd(), env, stdio: "pipe"
    });
    const output = execFileSync(process.execPath, ["src/apply-retention.js"], {
      cwd: process.cwd(), env, encoding: "utf8", stdio: "pipe"
    });
    assert.match(output, /delivery/);
    const db = new Database(databasePath);
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM delivery_outbox").get().n, 0);
      const event = db.prepare("SELECT user_id,action FROM audit_log WHERE action='retention_applied'").get();
      assert.ok(event);
      assert.equal(event.user_id, null);
    } finally { db.close(); }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
