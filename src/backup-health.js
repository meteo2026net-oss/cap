import "dotenv/config";
import path from "node:path";
import { listDatabaseBackups } from "./backup-utils.js";

const directory = path.resolve(process.argv[2] || process.env.BACKUP_DIR || "backups");
const configuredHours = Number(process.env.BACKUP_MAX_AGE_HOURS || 26);
const maxAgeHours = Number.isFinite(configuredHours) && configuredHours > 0 ? configuredHours : 26;
const now = new Date();

try {
  const backups = await listDatabaseBackups(directory);
  const newest = [...backups].sort((a, b) => Date.parse(b.modified_at) - Date.parse(a.modified_at))[0] || null;
  let status = "healthy";
  let reason = "A recent verified database backup is available.";
  if (!newest) {
    status = "missing";
    reason = "No matching database backups were found.";
  } else if (!newest.verified) {
    status = "invalid";
    reason = "The newest backup candidate failed verification.";
  } else {
    const ageHours = Math.max(0, (now.getTime() - Date.parse(newest.modified_at)) / 3600000);
    if (ageHours > maxAgeHours) {
      status = "stale";
      reason = `The newest verified backup is ${ageHours.toFixed(2)} hours old (limit: ${maxAgeHours}).`;
    }
  }
  const report = {
    status,
    healthy: status === "healthy",
    directory,
    checked_at: now.toISOString(),
    max_age_hours: maxAgeHours,
    newest_backup: newest ? {
      name: newest.name,
      modified_at: newest.modified_at,
      verified: newest.verified,
      ...(newest.error ? { error: newest.error } : {})
    } : null,
    total: backups.length,
    verified: backups.filter(item => item.verified).length,
    invalid: backups.filter(item => !item.verified).length,
    reason
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.healthy) process.exitCode = 1;
} catch (error) {
  console.error("Backup health check failed:", error.message);
  process.exitCode = 2;
}
