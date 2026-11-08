import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyOperationalRetention, collectOperationalMetrics, pruneDeliveryOutbox } from "../src/retention.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cap-retention-"));
  const dbPath = path.join(root, "t.sqlite");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE delivery_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id INTEGER,
      channel TEXT,
      payload TEXT,
      status TEXT,
      created_at TEXT,
      updated_at TEXT,
      delivered_at TEXT,
      dead_letter_at TEXT
    );
    CREATE TABLE webhook_inbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      received_at TEXT,
      source_timestamp INTEGER,
      signature_hash TEXT,
      payload_json TEXT,
      status TEXT,
      reviewed_at TEXT
    );
    CREATE TABLE alerts (id INTEGER PRIMARY KEY, workflow TEXT, scope TEXT);
    CREATE TABLE organizations (id INTEGER PRIMARY KEY, slug TEXT);
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY, alert_id INTEGER, action TEXT);
  `);
  return { root, db };
}

test("delivery retention removes only terminal aged rows", async () => {
  const { root, db } = await fixture();
  try {
    db.prepare(`INSERT INTO delivery_outbox(alert_id,channel,payload,status,created_at,updated_at,delivered_at,dead_letter_at) VALUES
      (1,'cap_feed','{}','delivered',datetime('now','-120 days'),datetime('now','-120 days'),datetime('now','-120 days'),NULL),
      (1,'cap_feed','{}','failed',datetime('now','-120 days'),datetime('now','-120 days'),NULL,datetime('now','-120 days')),
      (1,'cap_feed','{}','queued',datetime('now','-120 days'),datetime('now','-120 days'),NULL,NULL),
      (1,'cap_feed','{}','delivered',datetime('now','-1 days'),datetime('now','-1 days'),datetime('now','-1 days'),NULL)
    `).run();
    const result = pruneDeliveryOutbox(db, { retentionDays: 90 });
    assert.equal(result.deleted, 2);
    const remaining = db.prepare("SELECT status FROM delivery_outbox ORDER BY id").all().map(r => r.status);
    assert.deepEqual(remaining, ["queued", "delivered"]);
  } finally {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("applyOperationalRetention never deletes audit rows", async () => {
  const { root, db } = await fixture();
  try {
    db.prepare("INSERT INTO audit_log(action) VALUES ('created'), ('published')").run();
    db.prepare(`INSERT INTO webhook_inbox(received_at,source_timestamp,signature_hash,payload_json,status,reviewed_at)
      VALUES (datetime('now','-200 days'),1,'h','{}','reviewed',datetime('now','-200 days')),
             (datetime('now','-1 days'),2,'h2','{}','pending',NULL)`).run();
    const result = applyOperationalRetention(db, { deliveryRetentionDays: 90, webhookRetentionDays: 90 });
    assert.equal(result.audit_log.deleted, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log").get().n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM webhook_inbox").get().n, 1);
    assert.equal(db.prepare("SELECT status FROM webhook_inbox").get().status, "pending");
  } finally {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("collectOperationalMetrics reports queue and database health", async () => {
  const { root, db } = await fixture();
  try {
    db.prepare("INSERT INTO alerts(workflow,scope) VALUES ('published','Public'), ('draft','Private')").run();
    db.prepare(`INSERT INTO delivery_outbox(alert_id,channel,payload,status,created_at,updated_at)
      VALUES (1,'cap_feed','{}','queued',datetime('now'),datetime('now')),
             (2,'cap_feed','private-payload','queued',datetime('now'),datetime('now'))`).run();
    db.prepare("INSERT INTO organizations(slug) VALUES ('tenant-a')").run();
    db.prepare("INSERT INTO audit_log(alert_id,action) VALUES (1,'public_event'), (2,'private_event'), (NULL,'tenant_membership_event')").run();
    const metrics = collectOperationalMetrics(db);
    assert.equal(metrics.database.quick_check, "ok");
    assert.equal(metrics.delivery_outbox.queued, 1, "queue metrics must exclude non-Public deliveries");
    assert.equal(metrics.external_adapters_enabled, false);
    assert.equal(metrics.alerts_by_workflow.published, 1);
    assert.equal(metrics.alerts_by_workflow.draft, undefined, "workflow metrics must exclude non-Public alerts");
    assert.equal(metrics.audit_log_entries, 1, "audit metrics must exclude events attached to non-Public alerts");
  } finally {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
