import "dotenv/config";
import { refreshAuditCheckpoint } from "../src/audit.js";

let db;
try {
  if (!process.argv.includes("--confirm-offhost-evidence")) {
    throw new Error("Refusing checkpoint refresh without --confirm-offhost-evidence; first compare the checkpoint with independently protected off-host evidence and review later audit entries");
  }
  ({ db } = await import("../src/db.js"));
  const checkpointPath = process.env.AUDIT_CHECKPOINT_PATH;
  const checkpointSecret = process.env.AUDIT_CHECKPOINT_SECRET;
  const result = refreshAuditCheckpoint(db, {
    checkpointPath, checkpointSecret, offHostEvidenceReviewed: true
  });
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  console.error("Audit checkpoint refresh failed:", error.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
