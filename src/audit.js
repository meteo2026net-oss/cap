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
}

export function appendAuditLog(database, { userId = null, alertId = null, action, details = "" }) {
  if (typeof action !== "string" || !action.trim()) {
    throw new TypeError("Audit action must be a non-empty string");
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
  const rows = database.prepare(`
    SELECT id,user_id,alert_id,action,details,created_at,previous_hash,entry_hash
    FROM audit_log
    WHERE entry_hash IS NOT NULL
    ORDER BY id ASC
  `).all();
  const legacyRows = database.prepare(
    "SELECT id FROM audit_log WHERE entry_hash IS NULL ORDER BY id ASC"
  ).all();
  const legacyEntries = legacyRows.length;
  const firstHashedId = rows[0]?.id;
  const unhashedAfterChain = firstHashedId === undefined
    ? []
    : legacyRows.filter(row => row.id > firstHashedId);
  if (unhashedAfterChain.length) {
    return {
      valid: false,
      verified_entries: 0,
      total_hashed_entries: rows.length,
      legacy_unhashed_entries: legacyEntries,
      first_invalid_id: unhashedAfterChain[0].id,
      reason: "unhashed_entry_after_chain"
    };
  }

  let previousHash = GENESIS_HASH;
  for (const row of rows) {
    if (row.previous_hash !== previousHash) {
      return {
        valid: false,
        verified_entries: rows.findIndex(item => item.id === row.id),
        total_hashed_entries: rows.length,
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
        verified_entries: rows.findIndex(item => item.id === row.id),
        total_hashed_entries: rows.length,
        legacy_unhashed_entries: legacyEntries,
        first_invalid_id: row.id,
        reason: "entry_hash_mismatch"
      };
    }
    previousHash = row.entry_hash;
  }

  return {
    valid: true,
    verified_entries: rows.length,
    total_hashed_entries: rows.length,
    legacy_unhashed_entries: legacyEntries,
    latest_hash: rows.at(-1)?.entry_hash || null
  };
}
