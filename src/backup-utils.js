import Database from "better-sqlite3";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { verifyAuditChain } from "./audit.js";

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function writeChecksum(filePath) {
  const checksumPath = `${filePath}.sha256`;
  const temporary = `${checksumPath}.${randomUUID()}.tmp`;
  const digest = await sha256File(filePath);
  try {
    await fs.writeFile(temporary, `${digest}  ${path.basename(filePath)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, checksumPath);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function verifyChecksum(filePath) {
  const manifestPath = `${filePath}.sha256`;
  const manifestStat = await fs.lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 512) {
    throw new Error("Backup SHA-256 manifest must be a regular file no larger than 512 bytes");
  }
  const content = await fs.readFile(manifestPath, "utf8");
  const match = /^([a-f0-9]{64})  ([^\r\n]+)\n?$/.exec(content);
  if (!match || match[2] !== path.basename(filePath)) throw new Error("Backup SHA-256 manifest is malformed or names a different file");
  const expected = Buffer.from(match[1], "hex");
  const received = Buffer.from(await sha256File(filePath), "hex");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error("Backup SHA-256 checksum verification failed");
}
function timestampSlug(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z");
}


const CAP_STATUSES = new Set(["Actual", "Exercise", "System", "Test"]);
const CAP_MESSAGE_TYPES = new Set(["Alert", "Update", "Cancel", "Ack", "Error"]);
const ALERT_WORKFLOWS = new Set(["draft", "pending", "approved", "published", "cancelled"]);

function inspectAlertState(database) {
  const columns = new Set(database.prepare("PRAGMA table_info(alerts)").all().map(column => column.name));
  const required = ["identifier", "sender", "sent", "status", "msg_type", "references_text", "workflow"];
  const missing = required.filter(column => !columns.has(column));
  if (missing.length) {
    return { available: false, reason: "legacy_alert_schema", missing_columns: missing };
  }

  const alerts = database.prepare(`
    SELECT identifier, sender, sent, status, msg_type, references_text, workflow
    FROM alerts ORDER BY id
  `).all();
  const identities = new Set(alerts.map(alert => `${alert.sender},${alert.identifier},${alert.sent}`));
  const statusCounts = {};
  const messageTypeCounts = {};
  const workflowCounts = {};
  let referenceCount = 0;
  let resolvedInternalReferences = 0;
  let unresolvedExternalReferences = 0;

  for (const alert of alerts) {
    if (!alert.identifier?.trim() || !alert.sender?.trim() ||
        !/^[^\s,<>]+$/.test(alert.identifier) || !/^[^\s,<>]+$/.test(alert.sender)) {
      throw new Error("Restored alert has an invalid CAP sender or identifier");
    }
    if (!Number.isFinite(Date.parse(alert.sent)) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(alert.sent)) {
      throw new Error(`Restored alert ${alert.identifier} has an invalid CAP sent timestamp`);
    }
    if (!CAP_STATUSES.has(alert.status)) throw new Error(`Restored alert ${alert.identifier} has an invalid CAP status`);
    if (!CAP_MESSAGE_TYPES.has(alert.msg_type)) throw new Error(`Restored alert ${alert.identifier} has an invalid CAP message type`);
    if (!ALERT_WORKFLOWS.has(alert.workflow)) throw new Error(`Restored alert ${alert.identifier} has an invalid workflow state`);

    statusCounts[alert.status] = (statusCounts[alert.status] || 0) + 1;
    messageTypeCounts[alert.msg_type] = (messageTypeCounts[alert.msg_type] || 0) + 1;
    workflowCounts[alert.workflow] = (workflowCounts[alert.workflow] || 0) + 1;

    const references = String(alert.references_text || "").trim().split(/\s+/).filter(Boolean);
    if (["Update", "Cancel", "Ack", "Error"].includes(alert.msg_type) && !references.length) {
      throw new Error(`Restored CAP ${alert.msg_type} ${alert.identifier} is missing its references`);
    }
    for (const reference of references) {
      const parts = reference.split(",");
      if (parts.length !== 3 || parts.some(part => !part.trim()) ||
          !/^[^\s<>]+$/.test(parts[0]) || !/^[^\s<>]+$/.test(parts[1]) ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(parts[2]) ||
          !Number.isFinite(Date.parse(parts[2]))) {
        throw new Error(`Restored alert ${alert.identifier} contains a malformed CAP reference`);
      }
      referenceCount += 1;
      if (identities.has(reference)) resolvedInternalReferences += 1;
      else unresolvedExternalReferences += 1;
    }
  }

  return {
    available: true,
    alert_count: alerts.length,
    status_counts: statusCounts,
    message_type_counts: messageTypeCounts,
    workflow_counts: workflowCounts,
    references: {
      total: referenceCount,
      resolved_internal: resolvedInternalReferences,
      unresolved_external: unresolvedExternalReferences
    }
  };
}

async function validateDatabaseFile(filePath, auditOptions = {}) {
  const database = new Database(filePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = database.pragma("integrity_check");
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") {
      throw new Error("SQLite integrity_check failed");
    }
    const foreignKeyViolations = database.pragma("foreign_key_check");
    if (foreignKeyViolations.length) {
      throw new Error(`SQLite foreign_key_check failed (${foreignKeyViolations.length} violation(s))`);
    }
    const required = new Set(["users", "alerts", "audit_log"]);
    const actual = new Set(database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all().map(row => row.name));
    for (const name of required) {
      if (!actual.has(name)) throw new Error(`Database is missing required table: ${name}`);
    }

    const alertState = inspectAlertState(database);
    const auditColumns = database.prepare("PRAGMA table_info(audit_log)").all().map(row => row.name);
    const audit = auditColumns.includes("entry_hash") ? verifyAuditChain(database, auditOptions) : null;
    if (audit && !audit.valid) throw new Error("Audit hash chain verification failed: " + (audit.reason || "verification_failed"));
    return { integrity: "ok", audit, alert_state: alertState };
  } finally {
    database.close();
  }
}

export async function verifyDatabaseBackup(source, options = {}) {
  const sourcePath = path.resolve(source);
  const sourceStat = await fs.lstat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error("Backup source must be a regular file, not a symbolic link.");
  }
  const isNewFormat = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sqlite$/i.test(sourcePath);
  let checksum = "legacy";
  try {
    await fs.lstat(`${sourcePath}.sha256`);
    await verifyChecksum(sourcePath);
    checksum = "verified";
  } catch (error) {
    if (error.code !== "ENOENT" || isNewFormat) throw error;
  }
  const validation = await validateDatabaseFile(sourcePath, options.auditOptions);
  return { file: sourcePath, checksum, ...validation };
}

export async function verifyRestoredDatabase(source, options = {}) {
  const file = path.resolve(source);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Restored database must be a regular file, not a symbolic link.");
  }
  const validation = await validateDatabaseFile(file, options.auditOptions);
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const count = table => database.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count;
    const tables = new Set(database.prepare(
      "SELECT name FROM sqlite_master WHERE type='table'"
    ).all().map(row => row.name));
    const counts = {};
    for (const table of ["users", "alerts", "audit_log"]) {
      if (tables.has(table)) counts[table] = count(table);
    }
    const tableFingerprints = {};
    for (const table of [...tables].filter(name => !name.startsWith("sqlite_")).sort()) {
      const quote = identifier => `"${identifier.replaceAll('"', '""')}"`;
      const columns = database.prepare(`PRAGMA table_info(${quote(table)})`).all().map(column => column.name);
      const digest = createHash("sha256");
      let rowCount = 0;
      const order = columns.length ? ` ORDER BY ${columns.map(column => `${quote(column)} COLLATE BINARY`).join(", ")}` : "";
      for (const row of database.prepare(`SELECT * FROM ${quote(table)}${order}`).iterate()) {
        digest.update(JSON.stringify(row));
        digest.update(Buffer.from([0]));
        rowCount += 1;
      }
      tableFingerprints[table] = { rows: rowCount, sha256: digest.digest("hex") };
    }
    const tableCounts = Object.fromEntries(
      Object.entries(tableFingerprints).map(([name, fingerprint]) => [name, fingerprint.rows])
    );
    return {
      file,
      integrity: validation.integrity,
      audit: validation.audit,
      alert_state: validation.alert_state,
      counts,
      table_counts: tableCounts,
      table_fingerprints: tableFingerprints
    };
  } finally {
    database.close();
  }
}


export async function runIsolatedRestoreDrill(source, options = {}) {
  const sourcePath = path.resolve(source);
  const startedAt = new Date();
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "cap-restore-drill-"));
  const targetPath = path.join(workspace, "restored.sqlite");
  let report;
  try {
    const sourceBackup = await verifyDatabaseBackup(sourcePath, options);
    const sourceState = await verifyRestoredDatabase(sourcePath, options);

    // Exercise the same restore implementation used by the real restore CLI,
    // but point it at a fresh temporary target rather than the live DB_PATH.
    await restoreDatabaseBackup(sourcePath, targetPath, { auditOptions: options.auditOptions });
    const restoredState = await verifyRestoredDatabase(targetPath, options);

    if (JSON.stringify(sourceState.table_fingerprints) !== JSON.stringify(restoredState.table_fingerprints)) {
      throw new Error("Restore drill failed: one or more restored table contents differ from the source backup");
    }
    if (JSON.stringify(sourceState.audit) !== JSON.stringify(restoredState.audit)) {
      throw new Error("Restore drill failed: audit-chain or external-checkpoint verification differs after restore");
    }

    if (JSON.stringify(sourceState.alert_state) !== JSON.stringify(restoredState.alert_state)) {
      throw new Error("Restore drill failed: CAP alert workflow or reference state differs after restore");
    }

    const checkpoint = restoredState.audit?.checkpoint ?? null;
    const checkpointConfigured = Boolean(restoredState.audit?.integrity_capabilities?.external_checkpoint_configured);
    report = {
      result: "passed",
      source: sourcePath,
      started_at: startedAt.toISOString(),
      duration_ms: Date.now() - startedAt.getTime(),
      source_checksum: sourceBackup.checksum,
      integrity: restoredState.integrity,
      audit: restoredState.audit,
      alert_state: restoredState.alert_state,
      audit_checkpoint: {
        configured: checkpointConfigured,
        valid: checkpoint ? checkpoint.valid : null,
        checkpoint_latest_id: checkpoint?.checkpoint_latest_id ?? null
      },
      counts: restoredState.counts,
      table_counts: restoredState.table_counts,
      table_fingerprints: restoredState.table_fingerprints
    };
  } finally {
    await fs.rm(workspace, { recursive: true, force: true });
  }
  return { ...report, temporary_workspace_removed: true };
}

export async function createDatabaseBackup(database, directory, { now = new Date() } = {}) {
  await fs.mkdir(directory, { recursive: true });
  const destination = path.join(directory, `cap-${timestampSlug(now)}-${randomUUID()}.sqlite`);
  const temporary = `${destination}.tmp`;
  try {
    // Keep incomplete or not-yet-validated artifacts out of the visible backup set.
    await database.backup(temporary);
    await fs.chmod(temporary, 0o600);
    await validateDatabaseFile(temporary);
    await fs.rename(temporary, destination);
    await writeChecksum(destination);
    return destination;
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    await fs.rm(destination, { force: true }).catch(() => {});
    await fs.rm(`${destination}.sha256`, { force: true }).catch(() => {});
    throw error;
  }
}

export async function pruneDatabaseBackups(directory, { retentionDays = 30, now = new Date() } = {}) {
  if (!Number.isFinite(retentionDays) || retentionDays < 1) {
    throw new RangeError("Backup retention must be at least one day");
  }
  let names;
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
  const removed = [];
  for (const name of names) {
    if (!/^cap-\d{8}T\d{6}(?:\d{3})?Z(?:-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.sqlite$/.test(name)) continue;
    const filePath = path.join(directory, name);
    let stat;
    try {
      stat = await fs.lstat(filePath);
    } catch (error) {
      if (error.code === "ENOENT") continue; // Another process already removed it.
      throw error;
    }
    // Never follow or remove symlinks while pruning backup files.
    if (stat.isFile() && !stat.isSymbolicLink() && stat.mtimeMs < cutoff) {
      await fs.unlink(filePath);
      await fs.rm(`${filePath}.sha256`, { force: true });
      removed.push(name);
    }
  }
  return removed;
}

export async function restoreDatabaseBackup(source, destination, { force = false, fileSystem = fs, auditOptions = {} } = {}) {
  const sourcePath = path.resolve(source);
  const targetPath = path.resolve(destination);
  if (sourcePath === targetPath) throw new Error("Backup source and restore target must be different files");

  const sourceStat = await fs.lstat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error("Backup source must be a regular file, not a symbolic link.");
  }
  // UUID-named backups are the new format and must have a valid checksum manifest.
  // Legacy timestamp-only backups remain restorable for backward compatibility.
  if (/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sqlite$/i.test(sourcePath)) {
    await verifyChecksum(sourcePath);
  }
  const validation = await validateDatabaseFile(sourcePath, auditOptions);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  const sidecars = [`${targetPath}-wal`, `${targetPath}-shm`];
  for (const sidecar of sidecars) {
    try {
      // lstat also detects dangling symlinks; access() would treat those as absent.
      await fs.lstat(sidecar);
      throw new Error("SQLite WAL/SHM sidecar exists. Stop the service and resolve active database files before restoring.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  let targetStat = null;
  try {
    targetStat = await fs.lstat(targetPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (targetStat && !force) {
    throw new Error("Restore target already exists. Stop the service and pass --force to replace it.");
  }
  if (targetStat && (!targetStat.isFile() || targetStat.isSymbolicLink())) {
    throw new Error("Restore target must be a regular file, not a directory or symbolic link.");
  }

  const restoreId = randomUUID();
  const temporary = `${targetPath}.restore-${process.pid}-${restoreId}.tmp`;
  const rollback = `${targetPath}.pre-restore-${timestampSlug(new Date())}-${restoreId}`;
  let movedOriginal = false;
  try {
    await fs.copyFile(sourcePath, temporary);
    await fs.chmod(temporary, 0o600);
    await validateDatabaseFile(temporary, auditOptions);

    if (targetStat) {
      await fileSystem.rename(targetPath, rollback);
      movedOriginal = true;
    }

    await fileSystem.rename(temporary, targetPath);
    return { target: targetPath, backup_validation: validation, previous_database: movedOriginal ? rollback : null };
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    if (movedOriginal) {
      try {
        await fileSystem.rename(rollback, targetPath);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Restore failed and the previous database could not be moved back into place. The preserved rollback file is: ${rollback}`
        );
      }
    }
    throw error;
  }
}


export async function listDatabaseBackups(directory) {
  const root = path.resolve(directory);
  let names;
  try {
    names = await fs.readdir(root);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const candidates = names.filter(name =>
    /^cap-\d{8}T\d{6}(?:\d{3})?Z(?:-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.sqlite$/i.test(name)
  ).sort().reverse();

  const results = [];
  for (const name of candidates) {
    const file = path.join(root, name);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      try {
        const verification = await verifyDatabaseBackup(file);
        results.push({
          file,
          name,
          size_bytes: stat.size,
          modified_at: stat.mtime.toISOString(),
          verified: true,
          checksum: verification.checksum,
          integrity: verification.integrity,
          audit: verification.audit
        });
      } catch (error) {
        results.push({
          file,
          name,
          size_bytes: stat.size,
          modified_at: stat.mtime.toISOString(),
          verified: false,
          error: error.message
        });
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return results;
}
