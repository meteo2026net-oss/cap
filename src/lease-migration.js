import { createHash } from "node:crypto";

export function migrateLeaseTokenStorage(database) {
  const migrate = database.transaction(() => {
    const columns = database.prepare("PRAGMA table_info(delivery_outbox)").all().map(column => column.name);
    if (!columns.includes("lease_token")) database.exec("ALTER TABLE delivery_outbox ADD COLUMN lease_token TEXT");
    if (!columns.includes("lease_token_hash")) database.exec("ALTER TABLE delivery_outbox ADD COLUMN lease_token_hash TEXT");

    // Convert active legacy leases before installing guards against plaintext writes.
    const legacyTokens = database.prepare(
      "SELECT id,lease_token FROM delivery_outbox WHERE lease_token IS NOT NULL"
    ).all();
    const update = database.prepare(
      "UPDATE delivery_outbox SET lease_token_hash=?,lease_token=NULL WHERE id=?"
    );
    for (const row of legacyTokens) {
      const digest = createHash("sha256").update(row.lease_token, "utf8").digest("hex");
      update.run(digest, row.id);
    }

    database.exec(`
      CREATE TRIGGER IF NOT EXISTS delivery_outbox_no_plaintext_lease_insert
      BEFORE INSERT ON delivery_outbox
      WHEN NEW.lease_token IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'Plaintext delivery lease tokens are forbidden');
      END;
      CREATE TRIGGER IF NOT EXISTS delivery_outbox_no_plaintext_lease_update
      BEFORE UPDATE OF lease_token ON delivery_outbox
      WHEN NEW.lease_token IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'Plaintext delivery lease tokens are forbidden');
      END;
    `);
    return legacyTokens.length;
  });
  return migrate.immediate();
}
