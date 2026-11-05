import "dotenv/config";
import path from "node:path";
import { verifyRestoredDatabase } from "./backup-utils.js";

const source = process.argv[2] || process.env.DB_PATH || "storage/cap.sqlite";
try {
  const result = await verifyRestoredDatabase(source);
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} catch (error) {
  console.error("Restored database verification failed:", error.message);
  process.exitCode = 1;
}
