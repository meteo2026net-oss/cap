import "dotenv/config";
import { verifyDatabaseBackup } from "./backup-utils.js";

const source = process.argv[2];
if (!source) {
  console.error("Usage: npm run backup:verify -- <backup-file>");
  process.exit(2);
}

try {
  const result = await verifyDatabaseBackup(source);
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  console.error("Backup verification failed:", error.message);
  process.exitCode = 1;
}
