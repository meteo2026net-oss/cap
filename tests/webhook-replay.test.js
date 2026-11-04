import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createWebhookSignature } from "../src/webhook-signature.js";
import { consumeWebhookReplay, initializeWebhookReplayStore, verifyAndConsumeWebhook } from "../src/webhook-replay.js";

const secret = "synthetic-replay-test-secret-at-least-32-bytes";
const body = JSON.stringify({ event: "replay-test" });
const timestamp = 1_800_000_000;

function createStore() {
  const database = new Database(":memory:");
  initializeWebhookReplayStore(database);
  return database;
}

test("replay store accepts a signature once and rejects its duplicate", () => {
  const database = createStore();
  try {
    const signature = createWebhookSignature(secret, timestamp, body);
    assert.equal(consumeWebhookReplay(database, signature, timestamp), true);
    assert.equal(consumeWebhookReplay(database, signature, timestamp), false);
  } finally {
    database.close();
  }
});

test("replay store accepts distinct signatures", () => {
  const database = createStore();
  try {
    const first = createWebhookSignature(secret, timestamp, body);
    const second = createWebhookSignature(secret, timestamp, body + "changed");
    assert.equal(consumeWebhookReplay(database, first, timestamp), true);
    assert.equal(consumeWebhookReplay(database, second, timestamp), true);
  } finally {
    database.close();
  }
});

test("expired replay entries are removed and their signatures can be consumed again", () => {
  const database = createStore();
  try {
    const signature = createWebhookSignature(secret, timestamp, body);
    assert.equal(consumeWebhookReplay(database, signature, timestamp, 300), true);
    assert.equal(consumeWebhookReplay(database, signature, timestamp + 300, 300), true);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM webhook_replay_guard").get().count, 1);
  } finally {
    database.close();
  }
});

test("replay store rejects malformed signatures and invalid time windows", () => {
  const database = createStore();
  try {
    assert.throws(() => consumeWebhookReplay(database, "bad", timestamp), /valid SHA-256/);
    const signature = createWebhookSignature(secret, timestamp, body);
    assert.throws(() => consumeWebhookReplay(database, signature, 0), /valid Unix timestamp/);
    assert.throws(() => consumeWebhookReplay(database, signature, timestamp, 299), /between 300 and 7200/);
    assert.throws(() => consumeWebhookReplay(database, signature, timestamp, 7201), /between 300 and 7200/);
  } finally {
    database.close();
  }
});


test("combined verifier accepts a valid webhook once and rejects its replay", () => {
  const database = createStore();
  try {
    const signature = createWebhookSignature(secret, timestamp, body);
    const options = { nowSeconds: timestamp, toleranceSeconds: 300, retentionSeconds: 600 };
    assert.equal(verifyAndConsumeWebhook(database, secret, timestamp, body, signature, options), true);
    assert.equal(verifyAndConsumeWebhook(database, secret, timestamp, body, signature, options), false);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM webhook_replay_guard").get().count, 1);
  } finally {
    database.close();
  }
});

test("combined verifier never consumes invalid, altered, or stale webhook signatures", () => {
  const database = createStore();
  try {
    const signature = createWebhookSignature(secret, timestamp, body);
    assert.equal(verifyAndConsumeWebhook(database, secret, timestamp, body + " ", signature, { nowSeconds: timestamp }), false);
    assert.equal(verifyAndConsumeWebhook(database, secret + "wrong", timestamp, body, signature, { nowSeconds: timestamp }), false);
    assert.equal(verifyAndConsumeWebhook(database, secret, timestamp, body, signature, { nowSeconds: timestamp + 301 }), false);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM webhook_replay_guard").get().count, 0);
  } finally {
    database.close();
  }
});

test("combined verifier rejects invalid replay retention after signature verification", () => {
  const database = createStore();
  try {
    const signature = createWebhookSignature(secret, timestamp, body);
    assert.throws(() => verifyAndConsumeWebhook(database, secret, timestamp, body, signature, {
      nowSeconds: timestamp,
      retentionSeconds: 299
    }), /between 300 and 7200/);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM webhook_replay_guard").get().count, 0);
  } finally {
    database.close();
  }
});
