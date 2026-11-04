const CHANNELS = new Set(["cap_feed", "webhook", "email", "sms", "push"]);

export function enqueueDelivery(database, { alertId, channel = "cap_feed", payload }) {
  if (!Number.isInteger(Number(alertId)) || Number(alertId) < 1) throw new TypeError("A valid alertId is required");
  if (!CHANNELS.has(channel)) throw new TypeError("Unsupported delivery channel");
  if (typeof payload !== "string" || payload.length === 0 || payload.length > 2_000_000) {
    throw new TypeError("Delivery payload must be a non-empty string up to 2 MB");
  }
  const result = database.prepare(
    `INSERT OR IGNORE INTO delivery_outbox (alert_id, channel, payload, status)
     VALUES (?, ?, ?, 'queued')`
  ).run(Number(alertId), channel, payload);
  return database.prepare("SELECT * FROM delivery_outbox WHERE alert_id=? AND channel=?").get(Number(alertId), channel);
}

export function claimDelivery(database, id) {
  const result = database.prepare(
    `UPDATE delivery_outbox
       SET status='sending', attempts=attempts+1, last_attempt_at=CURRENT_TIMESTAMP,
           updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND status='queued'`
  ).run(id);
  if (!result.changes) return null;
  return database.prepare("SELECT * FROM delivery_outbox WHERE id=?").get(id);
}

export function recordDeliveryReceipt(database, id, { status, externalId = "", details = "" }) {
  if (!["delivered", "failed"].includes(status)) throw new TypeError("Receipt status must be delivered or failed");
  if (typeof externalId !== "string" || externalId.length > 256) throw new TypeError("externalId is too long");
  if (typeof details !== "string" || details.length > 2000) throw new TypeError("Receipt details are too long");
  const result = database.prepare(
    `UPDATE delivery_outbox
       SET status=?, external_id=?, last_error=?, delivered_at=CASE WHEN ?='delivered' THEN CURRENT_TIMESTAMP ELSE delivered_at END,
           updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND status='sending'`
  ).run(status, externalId, status === "failed" ? details : "", status, id);
  if (!result.changes) return null;
  return database.prepare("SELECT * FROM delivery_outbox WHERE id=?").get(id);
}

export function retryDelivery(database, id) {
  const result = database.prepare(
    `UPDATE delivery_outbox
       SET status='queued', last_error='', updated_at=CURRENT_TIMESTAMP
     WHERE id=? AND status='failed'`
  ).run(id);
  if (!result.changes) return null;
  return database.prepare("SELECT * FROM delivery_outbox WHERE id=?").get(id);
}
