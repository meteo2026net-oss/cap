import { appendAuditLog } from "./audit.js";

/**
 * Local retention helpers for non-authoritative operational tables.
 * Audit log rows are intentionally NOT deleted: the hash chain requires an
 * append-only history. Off-host archival of audit evidence is an institutional
 * process documented in OPERATIONAL_READINESS.md.
 */
function assertPositiveDays(days, label) {
  if (!Number.isFinite(days) || days < 1 || days > 3650) throw new RangeError(`${label} must be between 1 and 3650 days`);
}
export function pruneDeliveryOutbox(database, { retentionDays = 90, nowSql = "now" } = {}) {
  assertPositiveDays(retentionDays, "delivery retentionDays");
  const result = database.prepare(`
    DELETE FROM delivery_outbox
    WHERE (status = 'delivered' OR (status = 'failed' AND dead_letter_at IS NOT NULL))
      AND COALESCE(delivered_at, dead_letter_at, updated_at, created_at) < datetime(?, '-' || ? || ' days')
  `).run(nowSql, retentionDays);
  return { deleted: result.changes, retention_days: retentionDays, table: "delivery_outbox" };
}
export function pruneWebhookInbox(database, { retentionDays = 90, nowSql = "now" } = {}) {
  assertPositiveDays(retentionDays, "webhook retentionDays");
  const result = database.prepare(`
    DELETE FROM webhook_inbox
    WHERE status IN ('reviewed', 'rejected')
      AND COALESCE(reviewed_at, received_at) < datetime(?, '-' || ? || ' days')
  `).run(nowSql, retentionDays);
  return { deleted: result.changes, retention_days: retentionDays, table: "webhook_inbox" };
}
export function collectOperationalMetrics(database) {
  const quick = database.pragma("quick_check");
  const foreignKeys = database.pragma("foreign_key_check");
  const outbox = database.prepare("SELECT status, COUNT(*) AS n FROM delivery_outbox GROUP BY status").all();
  const byStatus = Object.fromEntries(outbox.map(row => [row.status, row.n]));
  const oldestQueued = database.prepare("SELECT MIN(created_at) AS oldest FROM delivery_outbox WHERE status IN ('queued', 'failed')").get()?.oldest || null;
  const alerts = database.prepare("SELECT workflow, COUNT(*) AS n FROM alerts GROUP BY workflow").all();
  const auditCount = database.prepare("SELECT COUNT(*) AS n FROM audit_log").get().n;
  return {
    database: { quick_check: quick[0]?.quick_check === "ok" ? "ok" : "failed", foreign_keys: foreignKeys.length === 0 ? "ok" : "failed" },
    delivery_outbox: {
      by_status: byStatus, queued: byStatus.queued || 0, sending: byStatus.sending || 0,
      failed: byStatus.failed || 0, delivered: byStatus.delivered || 0,
      dead_lettered: database.prepare("SELECT COUNT(*) AS n FROM delivery_outbox WHERE status='failed' AND dead_letter_at IS NOT NULL").get().n,
      oldest_pending_at: oldestQueued
    },
    alerts_by_workflow: Object.fromEntries(alerts.map(row => [row.workflow, row.n])),
    audit_log_entries: auditCount, external_adapters_enabled: false
  };
}
export function applyOperationalRetention(database, {
  deliveryRetentionDays = Number(process.env.CAP_DELIVERY_RETENTION_DAYS || 90),
  webhookRetentionDays = Number(process.env.CAP_WEBHOOK_RETENTION_DAYS || 90)
} = {}) {
  return database.transaction(() => {
    const delivery = pruneDeliveryOutbox(database, { retentionDays: deliveryRetentionDays });
    const webhook = pruneWebhookInbox(database, { retentionDays: webhookRetentionDays });
    return { ok: true, delivery, webhook, audit_log: { deleted: 0, policy: "append-only hash chain; local deletion is not supported" } };
  })();
}

/**
 * Run retention and append its hash-chained audit event inside one outer
 * SQLite transaction. If audit persistence fails, all deletions roll back.
 * auditWriter injection exists solely for deterministic failure testing.
 */
export function applyOperationalRetentionWithAudit(database, {
  deliveryRetentionDays = Number(process.env.CAP_DELIVERY_RETENTION_DAYS || 90),
  webhookRetentionDays = Number(process.env.CAP_WEBHOOK_RETENTION_DAYS || 90),
  userId = null,
  auditWriter = appendAuditLog
} = {}) {
  return database.transaction(() => {
    const result = applyOperationalRetention(database, { deliveryRetentionDays, webhookRetentionDays });
    auditWriter(database, { userId, alertId: null, action: "retention_applied", details: JSON.stringify(result) });
    return result;
  }).immediate();
}
