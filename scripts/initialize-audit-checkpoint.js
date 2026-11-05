import "dotenv/config";
import { db } from "../src/db.js";
import { initializeAuditCheckpoint } from "../src/audit.js";

try {
  const checkpointPath = process.env.AUDIT_CHECKPOINT_PATH;
  const checkpointSecret = process.env.AUDIT_CHECKPOINT_SECRET;
  const result = initializeAuditCheckpoint(db, { checkpointPath, checkpointSecret });
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  console.error("Audit checkpoint initialization failed:", error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
