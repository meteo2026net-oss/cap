import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { migrateLeaseTokenStorage } from "../src/lease-migration.js";

function legacyDatabase() {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE delivery_outbox (
      id INTEGER PRIMARY KEY,
      alert_id INTEGER NOT NULL,
      channel TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'sending',
      lease_token TEXT
    );
    INSERT INTO delivery_outbox(id,alert_id,channel,payload,status,lease_token)
    VALUES (1,1,'webhook','<legacy/>','sending','legacy-secret-lease-token');
  `);
  return database;
}

test("legacy plaintext leases are atomically migrated to SHA-256 digests", () => {
  const database = legacyDatabase();
  try {
    const migrated = migrateLeaseTokenStorage(database);
    assert.equal(migrated, 1);
    const row = database.prepare(
      "SELECT lease_token,lease_token_hash FROM delivery_outbox WHERE id=1"
    ).get();
    assert.equal(row.lease_token, null);
    assert.equal(
      row.lease_token_hash,
      createHash("sha256").update("legacy-secret-lease-token", "utf8").digest("hex")
    );
  } finally {
    database.close();
  }
});

test("lease migration is idempotent and does not overwrite an existing digest", () => {
  const database = legacyDatabase();
  try {
    migrateLeaseTokenStorage(database);
    const firstDigest = database.prepare(
      "SELECT lease_token_hash FROM delivery_outbox WHERE id=1"
    ).get().lease_token_hash;
    assert.equal(migrateLeaseTokenStorage(database), 0);
    assert.equal(
      database.prepare("SELECT lease_token_hash FROM delivery_outbox WHERE id=1").get().lease_token_hash,
      firstDigest
    );
  } finally {
    database.close();
  }
});

test("database triggers reject plaintext lease inserts and updates", () => {
  const database = legacyDatabase();
  try {
    migrateLeaseTokenStorage(database);
    assert.throws(
      () => database.prepare(`
        INSERT INTO delivery_outbox(alert_id,channel,payload,lease_token)
        VALUES (2,'email','<new/>','plaintext-token')
      `).run(),
      /Plaintext delivery lease tokens are forbidden/
    );
    assert.throws(
      () => database.prepare(
        "UPDATE delivery_outbox SET lease_token='plaintext-token' WHERE id=1"
      ).run(),
      /Plaintext delivery lease tokens are forbidden/
    );
    assert.doesNotThrow(() => database.prepare(
      "UPDATE delivery_outbox SET lease_token_hash=? WHERE id=1"
    ).run("a".repeat(64)));
  } finally {
    database.close();
  }
});
