import { appendAuditLog, finalizeAuditCheckpoint } from "./audit.js";
/**
 * Local retention helpers for non-authoritative operational tables.
 * Audit log rows are intentionally NOT deleted: the hash chain requires an
 * append-only history. Off-host archival of audit evidence is an institutional
 * process documented in OPERATIONAL_READINESS.md.
 */

function assertPositiveDays(days, label) {
  if (!Number.isFinite(days) || days < 1 || days > 3650) {
    throw new RangeError(`${label} must be between 1 and 3650 days`);
  }
}

/**
 * Remove terminal delivery_outbox rows older than retentionDays.
 * Only delivered and dead-lettered rows are eligible.
 */
export function pruneDeliveryOutbox(database, { retentionDays = 90, nowSql = "now" } = {}) {
  assertPositiveDays(retentionDays, "delivery retentionDays");
  const result = database.prepare(`
    DELETE FROM delivery_outbox
    WHERE (
      status = 'delivered'
      OR (status = 'failed' AND dead_letter_at IS NOT NULL)
    )
      AND COALESCE(delivered_at, dead_letter_at, updated_at, created_at) < datetime(?, '-' || ? || ' days')
  `).run(nowSql, retentionDays);
  return { deleted: result.changes, retention_days: retentionDays, table: "delivery_outbox" };
}

/**
 * Remove reviewed/rejected webhook inbox rows older than retentionDays.
 * Pending inbox items are never deleted by retention.
 */
export function pruneWebhookInbox(database, { retentionDays = 90, nowSql = "now" } = {}) {
  assertPositiveDays(retentionDays, "webhook retentionDays");
  const result = database.prepare(`
    DELETE FROM webhook_inbox
    WHERE status IN ('reviewed', 'rejected')
      AND COALESCE(reviewed_at, received_at) < datetime(?, '-' || ? || ' days')
  `).run(nowSql, retentionDays);
  return { deleted: result.changes, retention_days: retentionDays, table: "webhook_inbox" };
}

/**
 * Collect operational queue/database metrics for monitoring probes.
 */
export function collectOperationalMetrics(database) {
  const quick = database.pragma("quick_check");
  const foreignKeys = database.pragma("foreign_key_check");
  const outbox = database.prepare(`
    SELECT d.status, COUNT(*) AS n
    FROM delivery_outbox d JOIN alerts a ON a.id=d.alert_id
    WHERE a.scope='Public'
    GROUP BY d.status
  `).all();
  const byStatus = Object.fromEntries(outbox.map(row => [row.status, row.n]));
  const oldestQueued = database.prepare(`
    SELECT MIN(d.created_at) AS oldest
    FROM delivery_outbox d JOIN alerts a ON a.id=d.alert_id
    WHERE a.scope='Public' AND d.status IN ('queued', 'failed')
  `).get()?.oldest || null;
  const alerts = database.prepare(`
    SELECT workflow, COUNT(*) AS n FROM alerts WHERE scope='Public' GROUP BY workflow
  `).all();
  const auditCount = database.prepare(`SELECT COUNT(*) AS n FROM audit_log l
    WHERE (l.alert_id IS NOT NULL AND EXISTS (SELECT 1 FROM alerts a WHERE a.id=l.alert_id AND a.scope='Public'))
      OR (l.alert_id IS NULL AND l.action<>'retention_applied')`).get().n;
  return {
    database: {
      quick_check: quick[0]?.quick_check === "ok" ? "ok" : "failed",
      foreign_keys: foreignKeys.length === 0 ? "ok" : "failed"
    },
    delivery_outbox: {
      by_status: byStatus,
      queued: byStatus.queued || 0,
      sending: byStatus.sending || 0,
      failed: byStatus.failed || 0,
      delivered: byStatus.delivered || 0,
      dead_lettered: database.prepare("SELECT COUNT(*) AS n FROM delivery_outbox d JOIN alerts a ON a.id=d.alert_id WHERE a.scope='Public' AND d.status='failed' AND d.dead_letter_at IS NOT NULL").get().n,
      oldest_pending_at: oldestQueued
    },
    alerts_by_workflow: Object.fromEntries(alerts.map(row => [row.workflow, row.n])),
    audit_log_entries: auditCount,
    external_adapters_enabled: false
  };
}

export function applyOperationalRetention(database, {
  deliveryRetentionDays = Number(process.env.CAP_DELIVERY_RETENTION_DAYS || 90),
  webhookRetentionDays = Number(process.env.CAP_WEBHOOK_RETENTION_DAYS || 90)
} = {}) {
  return database.transaction(() => {
    const delivery = pruneDeliveryOutbox(database, { retentionDays: deliveryRetentionDays });
    const webhook = pruneWebhookInbox(database, { retentionDays: webhookRetentionDays });
    return {
      ok: true,
      delivery,
      webhook,
      audit_log: {
        deleted: 0,
        policy: "append-only hash chain; local deletion is not supported"
      }
    };
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
  auditWriter = appendAuditLog,
  auditOptions = {}
} = {}) {
  let auditResult;
  const result = database.transaction(() => {
    const retentionResult = applyOperationalRetention(database, { deliveryRetentionDays, webhookRetentionDays });
    auditResult = auditWriter(
      database,
      { userId, alertId: null, action: "retention_applied", details: JSON.stringify(retentionResult) },
      { ...auditOptions, deferCheckpoint: auditWriter === appendAuditLog }
    );
    return retentionResult;
  }).immediate();

  // The external checkpoint is a separate filesystem trust anchor. Refresh it
  // only after the SQLite transaction commits, never while its transaction is open.
  if (auditWriter === appendAuditLog && auditResult?.checkpoint_pending) {
    try {
      finalizeAuditCheckpoint(auditResult, auditOptions);
    } catch {
      return {
        ...result,
        audit_checkpoint_warning: "Retention and its database audit event committed, but the external audit checkpoint could not be refreshed. Verify the checkpoint before the next audit append."
      };
    }
  }
  return result;
}
