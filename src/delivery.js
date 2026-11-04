import { randomUUID } from "node:crypto";

const CHANNELS = new Set(["cap_feed", "webhook", "email", "sms", "push"]);
const MAX_BACKOFF_SECONDS = 3600;

export function enqueueDelivery(database, { alertId, channel = "cap_feed", payload, maxAttempts = 5 }) {
  if (!Number.isInteger(Number(alertId)) || Number(alertId) < 1) throw new TypeError("A valid alertId is required");
  if (!CHANNELS.has(channel)) throw new TypeError("Unsupported delivery channel");
  if (typeof payload !== "string" || payload.length === 0 || payload.length > 2_000_000) {
    throw new TypeError("Delivery payload must be a non-empty string up to 2 MB");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new TypeError("maxAttempts must be an integer from 1 to 20");
  }
  database.prepare(
    `INSERT OR IGNORE INTO delivery_outbox (alert_id, channel, payload, status, max_attempts)
     VALUES (?, ?, ?, 'queued', ?)`
  ).run(Number(alertId), channel, payload, maxAttempts);
  return database.prepare("SELECT * FROM delivery_outbox WHERE alert_id=? AND channel=?").get(Number(alertId), channel);
}

export function claimDelivery(database, id) {
  const result = database.prepare(
    `UPDATE delivery_outbox
       SET status='sending', attempts=attempts+1, last_attempt_at=CURRENT_TIMESTAMP,
           lease_token=?, next_attempt_at=NULL, updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND status='queued' AND attempts < max_attempts AND dead_letter_at IS NULL`
  ).run(randomUUID(), id);
  if (!result.changes) return null;
  return database.prepare("SELECT * FROM delivery_outbox WHERE id=?").get(id);
}

export function recordDeliveryReceipt(database, id, { status, leaseToken, externalId = "", details = "" }) {
  if (!["delivered", "failed"].includes(status)) throw new TypeError("Receipt status must be delivered or failed");
  if (typeof leaseToken !== "string" || !/^[0-9a-f-]{36}$/i.test(leaseToken)) throw new TypeError("A valid delivery lease token is required");
  if (typeof externalId !== "string" || externalId.length > 256) throw new TypeError("externalId is too long");
  if (typeof details !== "string" || details.length > 2000) throw new TypeError("Receipt details are too long");
  const row = database.prepare("SELECT attempts,max_attempts FROM delivery_outbox WHERE id=? AND status='sending' AND lease_token=?").get(id, leaseToken);
  if (!row) return null;
  const delaySeconds = Math.min(MAX_BACKOFF_SECONDS, 30 * (2 ** Math.max(0, row.attempts - 1)));
  const terminal = status === "failed" && row.attempts >= row.max_attempts;
  const result = database.prepare(
    `UPDATE delivery_outbox
       SET status=?, external_id=?, last_error=?, lease_token=NULL,
           next_attempt_at=CASE WHEN ?='failed' AND ?=0 THEN datetime('now', '+' || ? || ' seconds') ELSE NULL END,
           dead_letter_at=CASE WHEN ?=1 THEN CURRENT_TIMESTAMP ELSE dead_letter_at END,
           delivered_at=CASE WHEN ?='delivered' THEN CURRENT_TIMESTAMP ELSE delivered_at END,
           updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND status='sending' AND lease_token=?`
  ).run(status, externalId, status === "failed" ? details : "", status, terminal ? 1 : 0,
        delaySeconds, terminal ? 1 : 0, status, id, leaseToken);
  if (!result.changes) return null;
  return database.prepare("SELECT * FROM delivery_outbox WHERE id=?").get(id);
}

export function retryDelivery(database, id) {
  const result = database.prepare(
    `UPDATE delivery_outbox
       SET status='queued', last_error='', next_attempt_at=NULL, updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND status='failed' AND dead_letter_at IS NULL AND attempts < max_attempts`
  ).run(id);
  if (!result.changes) return null;
  return database.prepare("SELECT * FROM delivery_outbox WHERE id=?").get(id);
}

export function processDueRetries(database) {
  const process = database.transaction(() => {
    const due = database.prepare(
      `SELECT id,alert_id FROM delivery_outbox
       WHERE status='failed' AND dead_letter_at IS NULL AND attempts >= max_attempts
       ORDER BY id ASC`
    ).all();
    if (due.length) {
      const ids = due.map(row => row.id);
      const marks = ids.map(() => "?").join(",");
      database.prepare(
        `UPDATE delivery_outbox SET dead_letter_at=CURRENT_TIMESTAMP, next_attempt_at=NULL,
          updated_at=CURRENT_TIMESTAMP WHERE id IN (${marks}) AND status='failed' AND dead_letter_at IS NULL`
      ).run(...ids);
    }
    const ready = database.prepare(
      `SELECT id,alert_id FROM delivery_outbox
       WHERE status='failed' AND dead_letter_at IS NULL AND attempts < max_attempts
         AND next_attempt_at IS NOT NULL AND julianday(next_attempt_at) <= julianday('now')
       ORDER BY id ASC`
    ).all();
    if (ready.length) {
      const ids = ready.map(row => row.id);
      const marks = ids.map(() => "?").join(",");
      database.prepare(
        `UPDATE delivery_outbox SET status='queued', lease_token=NULL, next_attempt_at=NULL,
          last_error=CASE WHEN last_error='' THEN 'Automatic retry scheduled' ELSE last_error || ' | Automatic retry scheduled' END,
          updated_at=CURRENT_TIMESTAMP
         WHERE id IN (${marks}) AND status='failed' AND dead_letter_at IS NULL`
      ).run(...ids);
    }
    return { requeued: ready, deadLettered: due };
  });
  return process.immediate();
}

export function recoverStaleDeliveries(database, staleMinutes = 10) {
  if (!Number.isInteger(staleMinutes) || staleMinutes < 1 || staleMinutes > 1440) {
    throw new TypeError("staleMinutes must be an integer from 1 to 1440");
  }
  const recover = database.transaction(() => {
    const stale = database.prepare(
      `SELECT id, alert_id, attempts, max_attempts FROM delivery_outbox
       WHERE status='sending' AND last_attempt_at IS NOT NULL
         AND julianday(last_attempt_at) <= julianday('now', ?)
       ORDER BY id ASC`
    ).all(`-${staleMinutes} minutes`);
    if (stale.length) {
      const ids = stale.map(row => row.id);
      const placeholders = ids.map(() => "?").join(",");
      database.prepare(
        `UPDATE delivery_outbox SET status='queued', lease_token=NULL,
           last_error=CASE WHEN last_error='' THEN 'Recovered stale sending lease' ELSE last_error || ' | Recovered stale sending lease' END,
           updated_at=CURRENT_TIMESTAMP
         WHERE id IN (${placeholders}) AND status='sending' AND attempts < max_attempts`
      ).run(...ids);
      database.prepare(
        `UPDATE delivery_outbox SET status='failed', lease_token=NULL, dead_letter_at=CURRENT_TIMESTAMP,
           last_error=CASE WHEN last_error='' THEN 'Maximum attempts reached after stale lease' ELSE last_error || ' | Maximum attempts reached after stale lease' END,
           updated_at=CURRENT_TIMESTAMP
         WHERE id IN (${placeholders}) AND status='sending' AND attempts >= max_attempts`
      ).run(...ids);
    }
    const recovered = stale.filter(row => row.attempts < row.max_attempts);
    const deadLettered = stale.filter(row => row.attempts >= row.max_attempts);
    return { recovered, deadLettered };
  });
  return recover.immediate();
}
