import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installRecipientSchema, createOrganization } from "../src/recipient-auth.js";
import {
  createWebhookSource,
  disableWebhookSource,
  ensureWebhookSourcesSchema,
  resolveActiveWebhookSource
} from "../src/webhook-sources.js";

// Encryption helpers require a stable 32-byte key for the test process.
process.env.MFA_ENCRYPTION_KEY = process.env.MFA_ENCRYPTION_KEY || "a".repeat(64);

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cap-webhook-src-"));
  const db = new Database(path.join(root, "t.sqlite"));
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL DEFAULT 'x',
      role TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1
    );
  `);
  db.prepare("INSERT INTO users(username,role) VALUES ('admin','admin')").run();
  installRecipientSchema(db);
  ensureWebhookSourcesSchema(db);
  const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  const orgA = createOrganization(db, { slug: "org-a", name: "Org A", actorUserId: adminId });
  const orgB = createOrganization(db, { slug: "org-b", name: "Org B", actorUserId: adminId });
  return { root, db, adminId, orgA, orgB };
}

test("webhook source resolves only for active organization-bound registry entries", async () => {
  const { root, db, adminId, orgA, orgB } = await fixture();
  try {
    const secretA = "source-a-secret-that-is-at-least-32-bytes-long";
    const created = createWebhookSource(db, {
      organizationId: orgA,
      sourceKey: "source-a",
      secret: secretA,
      actorUserId: adminId
    });
    assert.equal(created.organization_id, orgA);
    const resolved = resolveActiveWebhookSource(db, "source-a");
    assert.ok(resolved);
    assert.equal(resolved.organization_id, orgA);
    assert.equal(resolved.secret, secretA);
    assert.equal(resolveActiveWebhookSource(db, "missing"), null);
    assert.equal(disableWebhookSource(db, created.id), true);
    assert.equal(resolveActiveWebhookSource(db, "source-a"), null);
    createWebhookSource(db, {
      organizationId: orgB,
      sourceKey: "source-b",
      secret: "source-b-secret-that-is-at-least-32-bytes-long",
      actorUserId: adminId
    });
    const resolvedB = resolveActiveWebhookSource(db, "source-b");
    assert.equal(resolvedB.organization_id, orgB);
    assert.notEqual(resolvedB.organization_id, orgA);
  } finally {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("webhook source rejects weak secrets and duplicate keys", async () => {
  const { root, db, adminId, orgA } = await fixture();
  try {
    assert.throws(() => createWebhookSource(db, {
      organizationId: orgA, sourceKey: "x", secret: "short", actorUserId: adminId
    }));
    createWebhookSource(db, {
      organizationId: orgA,
      sourceKey: "unique-source",
      secret: "unique-source-secret-that-is-at-least-32-bytes",
      actorUserId: adminId
    });
    assert.throws(() => createWebhookSource(db, {
      organizationId: orgA,
      sourceKey: "unique-source",
      secret: "another-source-secret-that-is-at-least-32-bytes",
      actorUserId: adminId
    }));
  } finally {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
