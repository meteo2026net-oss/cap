import "dotenv/config";
import { db } from "../src/db.js";
import { refreshAuditCheckpoint } from "../src/audit.js";

try {
  const checkpointPath = process.env.AUDIT_CHECKPOINT_PATH;
  const checkpointSecret = process.env.AUDIT_CHECKPOINT_SECRET;
  const result = refreshAuditCheckpoint(db, { checkpointPath, checkpointSecret });
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  console.error("Audit checkpoint refresh failed:", error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
