import "dotenv/config";
import path from "node:path";
import { db } from "./db.js";
import { createDatabaseBackup, pruneDatabaseBackups } from "./backup-utils.js";

try {
  const directory = path.resolve(process.env.BACKUP_DIR || "backups");
  const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || 30);
  const file = await createDatabaseBackup(db, directory);
  const removed = await pruneDatabaseBackups(directory, { retentionDays });
  console.log(JSON.stringify({ ok: true, backup: file, retention_days: retentionDays, pruned: removed.length }));
} catch (error) {
  console.error("Database backup failed:", error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
