import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_CLOCK_SKEW_SECONDS = 300;

function validateSecret(secret) {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new TypeError("Webhook secret must contain at least 32 bytes");
  }
}

function normalizeBody(body) {
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body;
  throw new TypeError("Webhook body must be a string or Buffer");
}

export function createWebhookSignature(secret, timestamp, body) {
  validateSecret(secret);
  if (!Number.isSafeInteger(timestamp) || timestamp < 1) throw new TypeError("A valid Unix timestamp in seconds is required");
  const raw = normalizeBody(body);
  const digest = createHmac("sha256", secret).update(String(timestamp)).update(".").update(raw).digest("hex");
  return "sha256=" + digest;
}

export function verifyWebhookSignature(secret, timestamp, body, signature, {
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = MAX_CLOCK_SKEW_SECONDS
} = {}) {
  validateSecret(secret);
  if (!Number.isSafeInteger(timestamp) || timestamp < 1) return false;
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 1) return false;
  if (!Number.isSafeInteger(toleranceSeconds) || toleranceSeconds < 1 || toleranceSeconds > 3600) return false;
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  if (typeof signature !== "string" || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = Buffer.from(createWebhookSignature(secret, timestamp, body), "utf8");
  const received = Buffer.from(signature, "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
