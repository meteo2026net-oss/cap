import { createHash } from "node:crypto";
import { verifyWebhookSignature } from "./webhook-signature.js";

const SIGNATURE_PATTERN = /^sha256=[a-f0-9]{64}$/;

export function initializeWebhookReplayStore(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS webhook_replay_guard (
      signature_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_replay_expiry
      ON webhook_replay_guard(expires_at);
  `);
}

export function consumeWebhookReplay(database, signature, nowSeconds = Math.floor(Date.now() / 1000), retentionSeconds = 600) {
  if (typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature)) {
    throw new TypeError("A valid SHA-256 webhook signature is required");
  }
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 1) {
    throw new TypeError("A valid Unix timestamp in seconds is required");
  }
  if (!Number.isSafeInteger(retentionSeconds) || retentionSeconds < 300 || retentionSeconds > 7200) {
    throw new RangeError("Replay retention must be between 300 and 7200 seconds");
  }

  const signatureHash = createHash("sha256").update(signature, "utf8").digest("hex");
  const consume = database.transaction(() => {
    database.prepare("DELETE FROM webhook_replay_guard WHERE expires_at <= ?").run(nowSeconds);
    const result = database.prepare(`
      INSERT INTO webhook_replay_guard(signature_hash, expires_at, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(signature_hash) DO NOTHING
    `).run(signatureHash, nowSeconds + retentionSeconds, nowSeconds);
    return result.changes === 1;
  });
  return consume.immediate();
}


export function verifyAndConsumeWebhook(database, secret, timestamp, body, signature, {
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = 300,
  retentionSeconds = 600
} = {}) {
  if (!verifyWebhookSignature(secret, timestamp, body, signature, { nowSeconds, toleranceSeconds })) {
    return false;
  }
  return consumeWebhookReplay(database, signature, nowSeconds, retentionSeconds);
}
