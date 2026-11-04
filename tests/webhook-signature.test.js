import test from "node:test";
import assert from "node:assert/strict";
import { createWebhookSignature, verifyWebhookSignature } from "../src/webhook-signature.js";

const secret = "synthetic-webhook-secret-at-least-32-bytes-long";
const body = JSON.stringify({ event: "synthetic-test", value: 42 });
const timestamp = 1_800_000_000;

test("HMAC signatures verify for the exact timestamp and raw body", () => {
  const signature = createWebhookSignature(secret, timestamp, body);
  assert.match(signature, /^sha256=[a-f0-9]{64}$/);
  assert.equal(verifyWebhookSignature(secret, timestamp, body, signature, {
    nowSeconds: timestamp,
    toleranceSeconds: 300
  }), true);
});

test("HMAC verification rejects modified bodies, signatures and secrets", () => {
  const signature = createWebhookSignature(secret, timestamp, body);
  assert.equal(verifyWebhookSignature(secret, timestamp, body + " ", signature, { nowSeconds: timestamp }), false);
  assert.equal(verifyWebhookSignature(secret, timestamp, body, signature.slice(0, -1) + "0", { nowSeconds: timestamp }), false);
  assert.equal(verifyWebhookSignature(secret + "x", timestamp, body, signature, { nowSeconds: timestamp }), false);
});

test("HMAC verification rejects stale timestamps and malformed inputs", () => {
  const signature = createWebhookSignature(secret, timestamp, body);
  assert.equal(verifyWebhookSignature(secret, timestamp, body, signature, { nowSeconds: timestamp + 301 }), false);
  assert.equal(verifyWebhookSignature(secret, timestamp, body, signature, { nowSeconds: timestamp - 301 }), false);
  assert.equal(verifyWebhookSignature(secret, timestamp, body, "bad", { nowSeconds: timestamp }), false);
  assert.equal(verifyWebhookSignature(secret, 0, body, signature, { nowSeconds: timestamp }), false);
  assert.throws(() => createWebhookSignature("short", timestamp, body), /at least 32 bytes/);
  assert.throws(() => createWebhookSignature(secret, timestamp, {}), /string or Buffer/);
});

test("HMAC helper accepts Buffer bodies without changing their bytes", () => {
  const raw = Buffer.from([0, 1, 2, 255]);
  const signature = createWebhookSignature(secret, timestamp, raw);
  assert.equal(verifyWebhookSignature(secret, timestamp, raw, signature, { nowSeconds: timestamp }), true);
});
