import "dotenv/config";
import { db } from "./db.js";
import { applyOperationalRetentionWithAudit, collectOperationalMetrics } from "./retention.js";

try {
  const before = collectOperationalMetrics(db);
  const result = applyOperationalRetentionWithAudit(db, { userId: null });
  const after = collectOperationalMetrics(db);
  console.log(JSON.stringify({ ok: true, result, before: before.delivery_outbox, after: after.delivery_outbox }, null, 2));
} catch (error) {
  console.error("Retention apply failed:", error.message);
  process.exitCode = 1;
} finally {
  db.close();
}
