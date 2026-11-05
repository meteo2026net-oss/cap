import Database from "better-sqlite3";
import fs from "node:fs/promises";
import path from "node:path";
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

async function validateDatabaseFile(filePath) {
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

    const auditColumns = database.prepare("PRAGMA table_info(audit_log)").all().map(row => row.name);
    const audit = auditColumns.includes("entry_hash") ? verifyAuditChain(database) : null;
    if (audit && !audit.valid) throw new Error("Audit hash chain verification failed");
    return { integrity: "ok", audit };
  } finally {
    database.close();
  }
}

export async function verifyDatabaseBackup(source) {
  const sourcePath = path.resolve(source);
  const sourceStat = await fs.lstat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error("Backup source must be a regular file, not a symbolic link.");
  }
  const isNewFormat = /-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.sqlite$/i.test(sourcePath);
  let checksum = "legacy";
  try {
    await fs.lstat(`${sourcePath}.sha256`);
    await verifyChecksum(sourcePath);
    checksum = "verified";
  } catch (error) {
    if (error.code !== "ENOENT" || isNewFormat) throw error;
  }
  const validation = await validateDatabaseFile(sourcePath);
  return { file: sourcePath, checksum, ...validation };
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

export async function restoreDatabaseBackup(source, destination, { force = false, fileSystem = fs } = {}) {
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
  const validation = await validateDatabaseFile(sourcePath);
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
    await validateDatabaseFile(temporary);

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
