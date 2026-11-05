import { createHash, timingSafeEqual } from "node:crypto";

const GENESIS_HASH = "0".repeat(64);

function digest(entry) {
  const canonical = JSON.stringify({
    id: entry.id,
    user_id: entry.user_id ?? null,
    alert_id: entry.alert_id ?? null,
    action: entry.action,
    details: entry.details ?? "",
    created_at: entry.created_at,
    previous_hash: entry.previous_hash
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function installAuditLogGuards(database) {
  database.exec(`
    CREATE TRIGGER IF NOT EXISTS audit_log_no_update
    BEFORE UPDATE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
    BEFORE DELETE ON audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log is append-only');
    END;
  `);
  const columns = database.prepare("PRAGMA table_info(audit_log)").all().map(column => column.name);
  if (columns.includes("entry_hash")) {
    database.exec(`
      CREATE TRIGGER IF NOT EXISTS audit_log_no_unhashed_tail
      BEFORE INSERT ON audit_log
      WHEN EXISTS (SELECT 1 FROM audit_log WHERE entry_hash IS NOT NULL)
        AND NEW.entry_hash IS NULL
      BEGIN
        SELECT RAISE(ABORT, 'audit_log hash chain cannot accept unhashed entries');
      END;
    `);
  }
}

export function appendAuditLog(database, { userId = null, alertId = null, action, details = "" }) {
  if (typeof action !== "string" || !action.trim() || action.trim().length > 128) {
    throw new TypeError("Audit action must be a non-empty string up to 128 characters");
  }
  if (String(details ?? "").length > 4000) {
    throw new TypeError("Audit details must not exceed 4000 characters");
  }

  const append = database.transaction(() => {
    const previous = database.prepare(
      "SELECT entry_hash FROM audit_log WHERE entry_hash IS NOT NULL ORDER BY id DESC LIMIT 1"
    ).get();
    const previousHash = previous?.entry_hash || GENESIS_HASH;
    const id = database.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM audit_log").get().id;
    const entry = {
      id,
      user_id: userId,
      alert_id: alertId,
      action: action.trim(),
      details: String(details ?? ""),
      created_at: new Date().toISOString(),
      previous_hash: previousHash
    };
    const entryHash = digest(entry);

    database.prepare(`
      INSERT INTO audit_log
        (id,user_id,alert_id,action,details,created_at,previous_hash,entry_hash)
      VALUES
        (@id,@user_id,@alert_id,@action,@details,@created_at,@previous_hash,@entry_hash)
    `).run({ ...entry, entry_hash: entryHash });

    return { id, entry_hash: entryHash, previous_hash: previousHash };
  });

  return append.immediate();
}

export function verifyAuditChain(database) {
  const totalHashedEntries = database.prepare(
    "SELECT COUNT(*) AS count FROM audit_log WHERE entry_hash IS NOT NULL"
  ).get().count;
  const legacyEntries = database.prepare(
    "SELECT COUNT(*) AS count FROM audit_log WHERE entry_hash IS NULL"
  ).get().count;
  const firstHashedId = database.prepare(
    "SELECT MIN(id) AS id FROM audit_log WHERE entry_hash IS NOT NULL"
  ).get().id;
  const unhashedAfterChain = firstHashedId === null ? null : database.prepare(
    "SELECT MIN(id) AS id FROM audit_log WHERE entry_hash IS NULL AND id > ?"
  ).get(firstHashedId).id;

  if (unhashedAfterChain !== null) {
    return {
      valid: false,
      verified_entries: 0,
      total_hashed_entries: totalHashedEntries,
      legacy_unhashed_entries: legacyEntries,
      first_invalid_id: unhashedAfterChain,
      reason: "unhashed_entry_after_chain"
    };
  }

  let previousHash = GENESIS_HASH;
  let verifiedEntries = 0;
  const rows = database.prepare(`
    SELECT id,user_id,alert_id,action,details,created_at,previous_hash,entry_hash
    FROM audit_log
    WHERE entry_hash IS NOT NULL
    ORDER BY id ASC
  `);
  for (const row of rows.iterate()) {
    if (row.previous_hash !== previousHash) {
      return {
        valid: false,
        verified_entries: verifiedEntries,
        total_hashed_entries: totalHashedEntries,
        legacy_unhashed_entries: legacyEntries,
        first_invalid_id: row.id,
        reason: "previous_hash_mismatch"
      };
    }

    const expected = digest(row);
    const actualBuffer = Buffer.from(row.entry_hash, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
      return {
        valid: false,
        verified_entries: verifiedEntries,
        total_hashed_entries: totalHashedEntries,
        legacy_unhashed_entries: legacyEntries,
        first_invalid_id: row.id,
        reason: "entry_hash_mismatch"
      };
    }
    previousHash = row.entry_hash;
    verifiedEntries++;
  }

  return {
    valid: true,
    verified_entries: verifiedEntries,
    total_hashed_entries: totalHashedEntries,
    legacy_unhashed_entries: legacyEntries,
    latest_hash: previousHash === GENESIS_HASH ? null : previousHash
  };
}
