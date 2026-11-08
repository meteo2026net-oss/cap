import { createHash, randomBytes } from "node:crypto";
import { decryptTotpSecret, encryptTotpSecret } from "./mfa.js";

export function ensureWebhookSourcesSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS webhook_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      source_key TEXT NOT NULL UNIQUE COLLATE NOCASE,
      secret_enc TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
      label TEXT NOT NULL DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      disabled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_webhook_sources_org_status
      ON webhook_sources(organization_id, status, source_key);
  `);

  const inboxExists = database.prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='webhook_inbox'"
  ).get();
  if (inboxExists) {
    const columns = database.prepare("PRAGMA table_info(webhook_inbox)").all().map(column => column.name);
    if (!columns.includes("organization_id")) {
      database.exec("ALTER TABLE webhook_inbox ADD COLUMN organization_id INTEGER REFERENCES organizations(id)");
    }
    if (!columns.includes("webhook_source_id")) {
      database.exec("ALTER TABLE webhook_inbox ADD COLUMN webhook_source_id INTEGER REFERENCES webhook_sources(id)");
    }
    if (!columns.includes("source_key")) {
      database.exec("ALTER TABLE webhook_inbox ADD COLUMN source_key TEXT");
    }
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_webhook_inbox_org_status
        ON webhook_inbox(organization_id, status, id DESC);
    `);
  }
}

function normalizeSourceKey(sourceKey) {
  if (typeof sourceKey !== "string") return "";
  return sourceKey.trim();
}

export function assertValidWebhookSourceKey(sourceKey) {
  const key = normalizeSourceKey(sourceKey);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/.test(key)) {
    throw new Error("Webhook source_key must be 3-64 characters of letters, digits, dot, underscore or hyphen");
  }
  return key;
}

export function assertValidWebhookSourceSecret(secret) {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("Webhook source secret must contain at least 32 bytes");
  }
  if (/^REPLACE_WITH_/i.test(secret)) {
    throw new Error("Webhook source secret must not use a placeholder value");
  }
  return secret;
}

export function createWebhookSource(database, {
  organizationId,
  sourceKey,
  secret,
  label = "",
  actorUserId = null
}) {
  const key = assertValidWebhookSourceKey(sourceKey);
  const validatedSecret = assertValidWebhookSourceSecret(secret);
  if (!Number.isSafeInteger(organizationId) || organizationId < 1) {
    throw new Error("A valid organizationId is required");
  }
  const org = database.prepare("SELECT id,status FROM organizations WHERE id=?").get(organizationId);
  if (!org || org.status !== "active") throw new Error("Active organization not found");

  const secretEnc = encryptTotpSecret(validatedSecret);
  const result = database.prepare(`
    INSERT INTO webhook_sources(organization_id, source_key, secret_enc, status, label, created_by)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(organizationId, key, secretEnc, String(label || "").slice(0, 120), actorUserId);
  return {
    id: Number(result.lastInsertRowid),
    organization_id: organizationId,
    source_key: key,
    status: "active",
    label: String(label || "").slice(0, 120)
  };
}

export function disableWebhookSource(database, sourceId) {
  const result = database.prepare(`
    UPDATE webhook_sources
    SET status='disabled', disabled_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='active'
  `).run(sourceId);
  return result.changes === 1;
}

/**
 * Resolve a registered active webhook source by its public source_key.
 * Organization binding comes only from this registry — never from request body fields.
 */
export function resolveActiveWebhookSource(database, sourceKey) {
  const key = normalizeSourceKey(sourceKey);
  if (!key) return null;
  const row = database.prepare(`
    SELECT s.id, s.organization_id, s.source_key, s.secret_enc, s.status, o.status AS organization_status
    FROM webhook_sources s
    JOIN organizations o ON o.id = s.organization_id
    WHERE s.source_key = ? COLLATE NOCASE
    LIMIT 1
  `).get(key);
  if (!row || row.status !== "active" || row.organization_status !== "active") return null;
  let secret;
  try {
    secret = decryptTotpSecret(row.secret_enc);
  } catch {
    return null;
  }
  return {
    id: row.id,
    organization_id: row.organization_id,
    source_key: row.source_key,
    secret
  };
}

export function listWebhookSources(database, organizationId = null) {
  if (organizationId == null) {
    return database.prepare(`
      SELECT s.id, s.organization_id, s.source_key, s.status, s.label, s.created_at, s.disabled_at,
             o.slug AS organization_slug
      FROM webhook_sources s
      JOIN organizations o ON o.id = s.organization_id
      ORDER BY s.id DESC
    `).all();
  }
  return database.prepare(`
    SELECT s.id, s.organization_id, s.source_key, s.status, s.label, s.created_at, s.disabled_at,
           o.slug AS organization_slug
    FROM webhook_sources s
    JOIN organizations o ON o.id = s.organization_id
    WHERE s.organization_id = ?
    ORDER BY s.id DESC
  `).all(organizationId);
}

export function generateWebhookSourceSecret() {
  return randomBytes(32).toString("base64url");
}

export function hashWebhookSourceKey(sourceKey) {
  return createHash("sha256").update(String(sourceKey || ""), "utf8").digest("hex");
}
