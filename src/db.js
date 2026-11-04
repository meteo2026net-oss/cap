import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { installAuditLogGuards } from "./audit.js";
import { migrateLeaseTokenStorage } from "./lease-migration.js";

const storage = path.resolve("storage");
fs.mkdirSync(storage, { recursive: true });
export const db = new Database(path.join(storage, "cap.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 username TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('admin','forecaster','reviewer','approver','publisher','viewer')),
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS alerts (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 identifier TEXT NOT NULL UNIQUE,
 sender TEXT NOT NULL,
 sent TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('Actual','Exercise','System','Test')),
 msg_type TEXT NOT NULL CHECK(msg_type IN ('Alert','Update','Cancel','Ack','Error')),
 scope TEXT NOT NULL CHECK(scope IN ('Public','Restricted','Private')),
 references_text TEXT,
 event TEXT NOT NULL,
 category TEXT NOT NULL,
 response_type TEXT,
 urgency TEXT NOT NULL CHECK(urgency IN ('Immediate','Expected','Future','Past','Unknown')),
 severity TEXT NOT NULL CHECK(severity IN ('Extreme','Severe','Moderate','Minor','Unknown')),
 certainty TEXT NOT NULL CHECK(certainty IN ('Observed','Likely','Possible','Unlikely','Unknown')),
 effective TEXT,
 onset TEXT,
 expires TEXT,
 headline TEXT NOT NULL,
 description TEXT NOT NULL,
 instruction TEXT,
 area_desc TEXT NOT NULL,
 polygon TEXT,
 circle TEXT,
 language TEXT NOT NULL DEFAULT 'en-US',
 info_json TEXT,
 workflow TEXT NOT NULL DEFAULT 'draft' CHECK(workflow IN ('draft','pending','approved','published','cancelled')),
 created_by INTEGER REFERENCES users(id),
 approved_by INTEGER REFERENCES users(id),
 published_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 user_id INTEGER REFERENCES users(id),
 alert_id INTEGER REFERENCES alerts(id),
 action TEXT NOT NULL,
 details TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_alert_workflow ON alerts(workflow);
CREATE INDEX IF NOT EXISTS idx_alert_sent ON alerts(sent);

CREATE TABLE IF NOT EXISTS delivery_outbox (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 alert_id INTEGER NOT NULL REFERENCES alerts(id),
 channel TEXT NOT NULL CHECK(channel IN ('cap_feed','webhook','email','sms','push')),
 payload TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','sending','delivered','failed')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 external_id TEXT NOT NULL DEFAULT '',
 last_error TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 last_attempt_at TEXT,
 delivered_at TEXT,
 UNIQUE(alert_id,channel)
);
CREATE INDEX IF NOT EXISTS idx_delivery_status ON delivery_outbox(status, created_at);
CREATE INDEX IF NOT EXISTS idx_delivery_alert ON delivery_outbox(alert_id);

`);

 // Forward-compatible, idempotent SQLite migrations for existing installations.
 const alertColumns = db.prepare("PRAGMA table_info(alerts)").all().map(column => column.name);
 if (!alertColumns.includes("info_json")) db.exec("ALTER TABLE alerts ADD COLUMN info_json TEXT");

 const userColumns = db.prepare("PRAGMA table_info(users)").all().map(column => column.name);
 if (!userColumns.includes("token_version")) db.exec("ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0");

 const deliveryColumns = db.prepare("PRAGMA table_info(delivery_outbox)").all().map(column => column.name);
 if (!deliveryColumns.includes("max_attempts")) db.exec("ALTER TABLE delivery_outbox ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 20)");
 if (!deliveryColumns.includes("next_attempt_at")) db.exec("ALTER TABLE delivery_outbox ADD COLUMN next_attempt_at TEXT");
 if (!deliveryColumns.includes("dead_letter_at")) db.exec("ALTER TABLE delivery_outbox ADD COLUMN dead_letter_at TEXT");
 migrateLeaseTokenStorage(db);
 db.exec("CREATE INDEX IF NOT EXISTS idx_delivery_retry_due ON delivery_outbox(status,next_attempt_at,attempts)");


 const auditColumns = db.prepare("PRAGMA table_info(audit_log)").all().map(column => column.name);
 if (!auditColumns.includes("previous_hash")) db.exec("ALTER TABLE audit_log ADD COLUMN previous_hash TEXT");
 if (!auditColumns.includes("entry_hash")) db.exec("ALTER TABLE audit_log ADD COLUMN entry_hash TEXT");

 db.exec(`
  CREATE TRIGGER IF NOT EXISTS alerts_cap_status_insert
  BEFORE INSERT ON alerts
  WHEN NEW.status NOT IN ('Actual','Exercise','System','Test')
  BEGIN
    SELECT RAISE(ABORT, 'Invalid CAP 1.2 status');
  END;
  CREATE TRIGGER IF NOT EXISTS alerts_cap_status_update
  BEFORE UPDATE OF status ON alerts
  WHEN NEW.status NOT IN ('Actual','Exercise','System','Test')
  BEGIN
    SELECT RAISE(ABORT, 'Invalid CAP 1.2 status');
  END;
 `);

 installAuditLogGuards(db);


export function ensureAdmin() {
 const username = process.env.ADMIN_USERNAME || "admin";
 const password = process.env.ADMIN_PASSWORD;
 if (!password || password.length < 14) throw new Error("ADMIN_PASSWORD must be configured with at least 14 characters.");
 const existing = db.prepare("SELECT id FROM users WHERE username=?").get(username);
 if (!existing) {
   const hash = bcrypt.hashSync(password, 12);
   db.prepare("INSERT INTO users(username,password_hash,role) VALUES(?,?,?)").run(username, hash, "admin");
   console.log(`Initial administrator created: ${username}. Change the password after first login.`);
 }
}
