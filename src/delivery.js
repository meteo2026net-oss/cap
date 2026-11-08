import { alertRecipientGrantSql } from "./recipient-auth.js";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

const CHANNELS = new Set(["cap_feed", "webhook", "email", "sms", "push"]);
const MAX_BACKOFF_SECONDS = 3600;
const MAINTENANCE_BATCH_SIZE = 500;

export function hasNonPublicDeliveryOutbox(database) {
  return Boolean(database.prepare(`SELECT 1
    FROM delivery_outbox d JOIN alerts a ON a.id=d.alert_id
    WHERE a.scope<>'Public' LIMIT 1`).get());
}

function deliveryAlertAccessSql(alias, authorization) {
  if (!authorization || !Number.isSafeInteger(authorization.userId) ||
      !Number.isSafeInteger(authorization.organizationId)) return `${alias}.scope='Public'`;
  return `(${alias}.scope='Public' OR (${alias}.scope IN ('Restricted','Private') AND ${alertRecipientGrantSql(alias,"deliver")}))`;
}

function deliveryAuthorizationParams(authorization) {
  return authorization && Number.isSafeInteger(authorization.userId) &&
    Number.isSafeInteger(authorization.organizationId)
    ? [authorization.userId, authorization.organizationId] : [];
}

function hashLeaseToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function enqueueDelivery(database, { alertId, channel = "cap_feed", payload, maxAttempts = 5 }) {
  if (!Number.isInteger(Number(alertId)) || Number(alertId) < 1) throw new TypeError("A valid alertId is required");
  if (!CHANNELS.has(channel)) throw new TypeError("Unsupported delivery channel");
  if (typeof payload !== "string" || payload.length === 0 || Buffer.byteLength(payload, "utf8") > 2_000_000) {
    throw new TypeError("Delivery payload must be a non-empty UTF-8 string up to 2 MB");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new TypeError("maxAttempts must be an integer from 1 to 20");
  }
  const alert = database.prepare("SELECT scope FROM alerts WHERE id=?").get(Number(alertId));
  if (!alert || alert.scope !== "Public") {
    throw new TypeError("Delivery enqueue is restricted to existing Public alerts until recipient authorization is configured");
  }
  database.prepare(
    `INSERT OR IGNORE INTO delivery_outbox (alert_id, channel, payload, status, max_attempts)
     SELECT ?, ?, ?, 'queued', ? WHERE EXISTS (
       SELECT 1 FROM alerts WHERE id=? AND scope='Public'
     )`
  ).run(Number(alertId), channel, payload, maxAttempts, Number(alertId));
  const delivery = database.prepare(`SELECT d.* FROM delivery_outbox d
    JOIN alerts a ON a.id=d.alert_id
    WHERE d.alert_id=? AND d.channel=? AND a.scope='Public'`).get(Number(alertId), channel);
  if (!delivery) {
    throw new TypeError("Delivery enqueue is restricted to existing Public alerts until recipient authorization is configured");
  }
  return delivery;
}

export function claimDelivery(database, id, authorization = null) {
  const alertAccess = deliveryAlertAccessSql("a", authorization);
  const authParams = deliveryAuthorizationParams(authorization);
  const leaseToken = randomUUID();
  const result = database.prepare(
    `UPDATE delivery_outbox
       SET status='sending', attempts=attempts+1, last_attempt_at=CURRENT_TIMESTAMP,
           lease_token=NULL, lease_token_hash=?, next_attempt_at=NULL, updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND status='queued' AND attempts < max_attempts AND dead_letter_at IS NULL
       AND EXISTS (SELECT 1 FROM alerts a WHERE a.id=delivery_outbox.alert_id AND a.scope='Public')`
  ).run(hashLeaseToken(leaseToken), id);
  if (!result.changes) return null;
  const row = database.prepare("SELECT * FROM delivery_outbox WHERE id=?").get(id);
  const { lease_token_hash: _leaseTokenHash, ...safeRow } = row;
  return { ...safeRow, lease_token: leaseToken };
}

export function recordDeliveryReceipt(database, id, { status, leaseToken, externalId = "", details = "" }, authorization = null) {
  const alertAccess = deliveryAlertAccessSql("a", authorization);
  const authParams = deliveryAuthorizationParams(authorization);
  if (!["delivered", "failed"].includes(status)) throw new TypeError("Receipt status must be delivered or failed");
  if (typeof leaseToken !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(leaseToken)) throw new TypeError("A valid delivery lease token is required");
  if (typeof externalId !== "string" || externalId.length > 256) throw new TypeError("externalId is too long");
  if (typeof details !== "string" || details.length > 2000) throw new TypeError("Receipt details are too long");
  const row = database.prepare(`SELECT d.attempts,d.max_attempts,d.lease_token_hash
    FROM delivery_outbox d JOIN alerts a ON a.id=d.alert_id
    WHERE d.id=? AND d.status='sending' AND ${alertAccess}`).get(id, ...authParams);
  if (!row || typeof row.lease_token_hash !== "string") return null;
  const suppliedHash = Buffer.from(hashLeaseToken(leaseToken), "hex");
  const storedHash = Buffer.from(row.lease_token_hash, "hex");
  if (suppliedHash.length !== storedHash.length || !timingSafeEqual(suppliedHash, storedHash)) return null;
  const delaySeconds = Math.min(MAX_BACKOFF_SECONDS, 30 * (2 ** Math.max(0, row.attempts - 1)));
  const terminal = status === "failed" && row.attempts >= row.max_attempts;
  const result = database.prepare(
    `UPDATE delivery_outbox
       SET status=?, external_id=?, last_error=?, lease_token=NULL, lease_token_hash=NULL,
           next_attempt_at=CASE WHEN ?='failed' AND ?=0 THEN datetime('now', '+' || ? || ' seconds') ELSE NULL END,
           dead_letter_at=CASE WHEN ?=1 THEN CURRENT_TIMESTAMP ELSE dead_letter_at END,
           delivered_at=CASE WHEN ?='delivered' THEN CURRENT_TIMESTAMP ELSE delivered_at END,
           updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND status='sending' AND lease_token_hash=?
       AND EXISTS (SELECT 1 FROM alerts a WHERE a.id=delivery_outbox.alert_id AND a.scope='Public')`
  ).run(status, externalId, status === "failed" ? details : "", status, terminal ? 1 : 0,
        delaySeconds, terminal ? 1 : 0, status, id, row.lease_token_hash);
  if (!result.changes) return null;
  return database.prepare("SELECT * FROM delivery_outbox WHERE id=?").get(id);
}

export function retryDelivery(database, id, authorization = null) {
  const alertAccess = deliveryAlertAccessSql("a", authorization);
  const authParams = deliveryAuthorizationParams(authorization);
  const result = database.prepare(
    `UPDATE delivery_outbox
       SET status='queued', lease_token=NULL, lease_token_hash=NULL, last_error='', next_attempt_at=NULL, updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND status='failed' AND dead_letter_at IS NULL AND attempts < max_attempts
       AND EXISTS (SELECT 1 FROM alerts a WHERE a.id=delivery_outbox.alert_id AND a.scope='Public')`
  ).run(id);
  if (!result.changes) return null;
  return database.prepare("SELECT * FROM delivery_outbox WHERE id=?").get(id);
}

export function processDueRetries(database) {
  const process = database.transaction(() => {
    const due = database.prepare(
      `SELECT d.id,d.alert_id FROM delivery_outbox d JOIN alerts a ON a.id=d.alert_id
       WHERE a.scope='Public' AND d.status='failed' AND d.dead_letter_at IS NULL AND d.attempts >= d.max_attempts
       ORDER BY d.id ASC LIMIT ${MAINTENANCE_BATCH_SIZE}`
    ).all();
    if (due.length) {
      const ids = due.map(row => row.id);
      const marks = ids.map(() => "?").join(",");
      database.prepare(
        `UPDATE delivery_outbox SET dead_letter_at=CURRENT_TIMESTAMP, next_attempt_at=NULL,
          updated_at=CURRENT_TIMESTAMP WHERE id IN (${marks}) AND status='failed' AND dead_letter_at IS NULL
          AND EXISTS (SELECT 1 FROM alerts a WHERE a.id=delivery_outbox.alert_id AND a.scope='Public')`
      ).run(...ids);
    }
    const ready = database.prepare(
      `SELECT d.id,d.alert_id FROM delivery_outbox d JOIN alerts a ON a.id=d.alert_id
       WHERE a.scope='Public' AND d.status='failed' AND d.dead_letter_at IS NULL AND d.attempts < d.max_attempts
         AND d.next_attempt_at IS NOT NULL AND julianday(d.next_attempt_at) <= julianday('now')
       ORDER BY d.id ASC LIMIT ${MAINTENANCE_BATCH_SIZE}`
    ).all();
    if (ready.length) {
      const ids = ready.map(row => row.id);
      const marks = ids.map(() => "?").join(",");
      database.prepare(
        `UPDATE delivery_outbox SET status='queued', lease_token=NULL, next_attempt_at=NULL,
          last_error=CASE WHEN last_error='' THEN 'Automatic retry scheduled' ELSE last_error || ' | Automatic retry scheduled' END,
          updated_at=CURRENT_TIMESTAMP
         WHERE id IN (${marks}) AND status='failed' AND dead_letter_at IS NULL
           AND EXISTS (SELECT 1 FROM alerts a WHERE a.id=delivery_outbox.alert_id AND a.scope='Public')`
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
      `SELECT d.id,d.alert_id,d.attempts,d.max_attempts FROM delivery_outbox d JOIN alerts a ON a.id=d.alert_id
       WHERE a.scope='Public' AND d.status='sending' AND d.last_attempt_at IS NOT NULL
         AND julianday(d.last_attempt_at) <= julianday('now', ?)
       ORDER BY d.id ASC LIMIT ${MAINTENANCE_BATCH_SIZE}`
    ).all(`-${staleMinutes} minutes`);
    if (stale.length) {
      const ids = stale.map(row => row.id);
      const placeholders = ids.map(() => "?").join(",");
      database.prepare(
        `UPDATE delivery_outbox SET status='queued', lease_token=NULL, lease_token_hash=NULL,
           last_error=CASE WHEN last_error='' THEN 'Recovered stale sending lease' ELSE last_error || ' | Recovered stale sending lease' END,
           updated_at=CURRENT_TIMESTAMP
         WHERE id IN (${placeholders}) AND status='sending' AND attempts < max_attempts
           AND EXISTS (SELECT 1 FROM alerts a WHERE a.id=delivery_outbox.alert_id AND a.scope='Public')`
      ).run(...ids);
      database.prepare(
        `UPDATE delivery_outbox SET status='failed', lease_token=NULL, lease_token_hash=NULL, dead_letter_at=CURRENT_TIMESTAMP,
           last_error=CASE WHEN last_error='' THEN 'Maximum attempts reached after stale lease' ELSE last_error || ' | Maximum attempts reached after stale lease' END,
           updated_at=CURRENT_TIMESTAMP
         WHERE id IN (${placeholders}) AND status='sending' AND attempts >= max_attempts
           AND EXISTS (SELECT 1 FROM alerts a WHERE a.id=delivery_outbox.alert_id AND a.scope='Public')`
      ).run(...ids);
    }
    const recovered = stale.filter(row => row.attempts < row.max_attempts);
    const deadLettered = stale.filter(row => row.attempts >= row.max_attempts);
    return { recovered, deadLettered };
  });
  return recover.immediate();
}
