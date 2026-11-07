import Database from "better-sqlite3";

export function openReceiverStore(filename) {
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS receiver_messages (
      sender TEXT NOT NULL, identifier TEXT NOT NULL, sent TEXT NOT NULL,
      msg_type TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL,
      references_text TEXT NOT NULL DEFAULT '', received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(sender, identifier, sent)
    );
  `);
  return db;
}

export function persistReceiverMessage(db, message, validateReferences) {
  return db.transaction(() => {
    const known = db.prepare("SELECT sender,identifier,sent,msg_type,scope,status FROM receiver_messages").all();
    const validation = validateReferences(known);
    if (!validation.ok) return validation;
    const result = db.prepare(`
      INSERT INTO receiver_messages(sender,identifier,sent,msg_type,scope,status,references_text)
      VALUES (@sender,@identifier,@sent,@msgType,@scope,@status,@references)
      ON CONFLICT(sender,identifier,sent) DO NOTHING
    `).run({ ...message, references: message.references || "" });
    return { ok: true, duplicate: result.changes === 0 };
  }).immediate();
}
