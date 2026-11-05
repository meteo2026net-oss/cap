import "dotenv/config";
import path from "node:path";
import { listDatabaseBackups } from "./backup-utils.js";

const directory = path.resolve(process.argv[2] || process.env.BACKUP_DIR || "backups");
try {
  const backups = await listDatabaseBackups(directory);
  const summary = {
    directory,
    total: backups.length,
    verified: backups.filter(item => item.verified).length,
    invalid: backups.filter(item => !item.verified).length,
    backups
  };
  console.log(JSON.stringify(summary, null, 2));
  if (summary.invalid > 0) process.exitCode = 1;
} catch (error) {
  console.error("Could not list database backups:", error.message);
  process.exitCode = 1;
}
