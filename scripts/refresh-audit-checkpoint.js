import "dotenv/config";
import { db } from "../src/db.js";
import { refreshAuditCheckpoint } from "../src/audit.js";

try {
  const checkpointPath = process.env.AUDIT_CHECKPOINT_PATH;
  const checkpointSecret = process.env.AUDIT_CHECKPOINT_SECRET;
  if (!process.argv.includes("--confirm-offhost-evidence")) {
    throw new Error("Refusing checkpoint refresh without --confirm-offhost-evidence; first compare the checkpoint with independently protected off-host evidence and review later audit entries");
  }
  const result = refreshAuditCheckpoint(db, { checkpointPath, checkpointSecret, offHostEvidenceReviewed: true });
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  console.error("Audit checkpoint refresh failed:", error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
