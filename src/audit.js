import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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


function checkpointPayload(latestId, latestHash) {
  return { version: 1, latest_id: latestId, latest_hash: latestHash };
}
function checkpointSignature(payload, secret) {
  return createHmac("sha256", secret).update(JSON.stringify(payload), "utf8").digest("hex");
}
function writeExternalCheckpoint(checkpointPath, secret, latestId, latestHash) {
  if (!checkpointPath && !secret) return;
  if (!checkpointPath || typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("AUDIT_CHECKPOINT_PATH and an AUDIT_CHECKPOINT_SECRET of at least 32 bytes must both be configured");
  }
  const payload = checkpointPayload(latestId, latestHash);
  const document = { ...payload, signature: checkpointSignature(payload, secret), created_at: new Date().toISOString() };
  const destination = path.resolve(checkpointPath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = destination + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(document) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, destination);
    try { fs.chmodSync(destination, 0o600); } catch {}
  } finally { try { fs.rmSync(temporary, { force: true }); } catch {} }
}
function verifyExternalCheckpoint(database, checkpointPath, secret, latestId, latestHash) {
  const configured = Boolean(checkpointPath || secret);
  if (!configured) return { configured: false, valid: null, detects_final_tail_truncation: false };
  if (!checkpointPath || typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    return { configured: true, valid: false, reason: "checkpoint_configuration_invalid" };
  }
  let document;
  try { document = JSON.parse(fs.readFileSync(path.resolve(checkpointPath), "utf8")); }
  catch { return { configured: true, valid: false, reason: "checkpoint_unavailable_or_invalid" }; }
  const payload = checkpointPayload(document.latest_id, document.latest_hash);
  if (document.version !== 1 || !Number.isSafeInteger(payload.latest_id) || payload.latest_id < 1 ||
      typeof payload.latest_hash !== "string" || !/^[a-f0-9]{64}$/.test(payload.latest_hash) ||
      typeof document.signature !== "string") {
    return { configured: true, valid: false, reason: "checkpoint_format_invalid" };
  }
  const expected = Buffer.from(checkpointSignature(payload, secret), "hex");
  const actual = Buffer.from(document.signature, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { configured: true, valid: false, reason: "checkpoint_signature_invalid" };
  }
  const anchor = database.prepare("SELECT entry_hash FROM audit_log WHERE id=?").get(payload.latest_id);
  if (!anchor || anchor.entry_hash !== payload.latest_hash) {
    return { configured: true, valid: false, reason: "checkpoint_anchor_missing_or_changed" };
  }
  if (latestId !== payload.latest_id || latestHash !== payload.latest_hash) {
    return { configured: true, valid: false, reason: "checkpoint_stale_or_database_rollback" };
  }
  return { configured: true, valid: true, detects_final_tail_truncation: true, checkpoint_latest_id: payload.latest_id };
}

export function initializeAuditCheckpoint(database, { checkpointPath, checkpointSecret }) {
  if (!checkpointPath || typeof checkpointSecret !== "string" || Buffer.byteLength(checkpointSecret, "utf8") < 32) {
    throw new Error("A checkpoint path and secret of at least 32 bytes are required");
  }
  if (fs.existsSync(path.resolve(checkpointPath))) throw new Error("Checkpoint already exists; refusing to overwrite the trust anchor");
  const baseline = verifyAuditChain(database, { checkpointPath: "", checkpointSecret: "" });
  if (!baseline.valid) throw new Error("Cannot anchor an invalid audit chain: " + (baseline.reason || "verification_failed"));
  if (!baseline.latest_hash) throw new Error("There are no hashed audit entries to anchor");
  const latest = database.prepare("SELECT id FROM audit_log WHERE entry_hash=? ORDER BY id DESC LIMIT 1").get(baseline.latest_hash);
  if (!latest) throw new Error("Unable to locate the latest verified audit entry");
  writeExternalCheckpoint(checkpointPath, checkpointSecret, latest.id, baseline.latest_hash);
  return { latest_id: latest.id, latest_hash: baseline.latest_hash };
}

export function appendAuditLog(database, { userId = null, alertId = null, action, details = "" }, options = {}) {
  if (typeof action !== "string" || !action.trim() || action.trim().length > 128) {
    throw new TypeError("Audit action must be a non-empty string up to 128 characters");
  }
  if (String(details ?? "").length > 4000) {
    throw new TypeError("Audit details must not exceed 4000 characters");
  }

  const checkpointPath = options.checkpointPath ?? process.env.AUDIT_CHECKPOINT_PATH;
  const checkpointSecret = options.checkpointSecret ?? process.env.AUDIT_CHECKPOINT_SECRET;
  if (checkpointPath || checkpointSecret) {
    const hashedCount = database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE entry_hash IS NOT NULL").get().count;
    if (hashedCount > 0) {
      const checkpointStatus = verifyAuditChain(database, { checkpointPath, checkpointSecret });
      if (!checkpointStatus.valid) {
        throw new Error("Audit checkpoint verification failed; refusing to append: " + (checkpointStatus.reason || "invalid_checkpoint"));
      }
    }
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

  const result = append.immediate();
  const checkpointPath = options.checkpointPath ?? process.env.AUDIT_CHECKPOINT_PATH;
  const checkpointSecret = options.checkpointSecret ?? process.env.AUDIT_CHECKPOINT_SECRET;
  if (checkpointPath || checkpointSecret) writeExternalCheckpoint(checkpointPath, checkpointSecret, result.id, result.entry_hash);
  return result;
}

export function verifyAuditChain(database, options = {}) {
  const checkpointPath = options.checkpointPath ?? process.env.AUDIT_CHECKPOINT_PATH;
  const checkpointSecret = options.checkpointSecret ?? process.env.AUDIT_CHECKPOINT_SECRET;
  const integrityCapabilities = {
    detects_entry_tampering: true,
    detects_internal_deletions: true,
    detects_final_tail_truncation: false,
    external_checkpoint_configured: Boolean(checkpointPath && checkpointSecret)
  };
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
      integrity_capabilities: integrityCapabilities,
      verified_entries: 0,
      total_hashed_entries: totalHashedEntries,
      legacy_unhashed_entries: legacyEntries,
      first_invalid_id: unhashedAfterChain,
      reason: "unhashed_entry_after_chain"
    };
  }

  let previousHash = GENESIS_HASH;
  let previousId = null;
  let verifiedEntries = 0;
  const rows = database.prepare(`
    SELECT id,user_id,alert_id,action,details,created_at,previous_hash,entry_hash
    FROM audit_log
    WHERE entry_hash IS NOT NULL
    ORDER BY id ASC
  `);
  for (const row of rows.iterate()) {
    if (previousId !== null && row.id !== previousId + 1) {
      return {
        valid: false,
        integrity_capabilities: integrityCapabilities,
        verified_entries: verifiedEntries,
        total_hashed_entries: totalHashedEntries,
        legacy_unhashed_entries: legacyEntries,
        first_invalid_id: row.id,
        reason: "sequence_gap"
      };
    }
    if (row.previous_hash !== previousHash) {
      return {
        valid: false,
        integrity_capabilities: integrityCapabilities,
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
        integrity_capabilities: integrityCapabilities,
        verified_entries: verifiedEntries,
        total_hashed_entries: totalHashedEntries,
        legacy_unhashed_entries: legacyEntries,
        first_invalid_id: row.id,
        reason: "entry_hash_mismatch"
      };
    }
    previousHash = row.entry_hash;
    previousId = row.id;
    verifiedEntries++;
  }

  const latestHash = previousHash === GENESIS_HASH ? null : previousHash;
  const checkpoint = verifyExternalCheckpoint(database, checkpointPath, checkpointSecret, previousId, latestHash);
  integrityCapabilities.external_checkpoint_configured = checkpoint.configured;
  integrityCapabilities.detects_final_tail_truncation = checkpoint.valid === true;
  if (checkpoint.configured && checkpoint.valid !== true) {
    return { valid: false, integrity_capabilities: integrityCapabilities, verified_entries: verifiedEntries,
      total_hashed_entries: totalHashedEntries, legacy_unhashed_entries: legacyEntries,
      latest_hash: latestHash, reason: checkpoint.reason || "checkpoint_invalid" };
  }
  return { valid: true, integrity_capabilities: integrityCapabilities, verified_entries: verifiedEntries,
    total_hashed_entries: totalHashedEntries, legacy_unhashed_entries: legacyEntries,
    latest_hash: latestHash, checkpoint: checkpoint.configured ? checkpoint : null };
}
