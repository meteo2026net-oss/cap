import "dotenv/config";
import path from "node:path";
import { restoreDatabaseBackup } from "./backup-utils.js";

const source = process.argv[2];
const force = process.argv.includes("--force");
if (!source) {
  console.error("Usage: npm run restore -- <backup-file> [--force]");
  process.exit(2);
}

try {
  const target = path.resolve(process.env.DB_PATH || "storage/cap.sqlite");
  const result = await restoreDatabaseBackup(source, target, { force });
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  console.error("Database restore failed:", error.message);
  process.exitCode = 1;
}
