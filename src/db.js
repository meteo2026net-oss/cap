import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";

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
 status TEXT NOT NULL CHECK(status IN ('Actual','Exercise','System','Test','Draft')),
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
`);

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
