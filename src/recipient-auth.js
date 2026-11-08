const TERMINAL_MEMBERSHIP_STATES = new Set(["revoked", "expired"]);
const ALLOWED_TRANSITIONS = Object.freeze({
  pending: new Set(["active", "revoked", "expired"]),
  active: new Set(["suspended", "revoked", "expired"]),
  suspended: new Set(["active", "revoked", "expired"]),
  revoked: new Set(),
  expired: new Set()
});

export function installRecipientSchema(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','suspended','archived')),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK(length(trim(slug)) BETWEEN 2 AND 80),
      CHECK(length(trim(name)) BETWEEN 2 AND 200)
    );

    CREATE TABLE IF NOT EXISTS organization_memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','active','suspended','revoked','expired')),
      starts_at TEXT,
      expires_at TEXT,
      created_by INTEGER NOT NULL REFERENCES users(id),
      approved_by INTEGER REFERENCES users(id),
      updated_by INTEGER REFERENCES users(id),
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK(expires_at IS NULL OR starts_at IS NULL OR julianday(expires_at) > julianday(starts_at)),
      CHECK(status <> 'active' OR approved_by IS NOT NULL),
      CHECK(status <> 'revoked' OR revoked_at IS NOT NULL)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_membership_one_open_period
      ON organization_memberships(organization_id,user_id)
      WHERE status IN ('pending','active','suspended');
    CREATE INDEX IF NOT EXISTS idx_membership_user_state
      ON organization_memberships(user_id,status,organization_id);
    CREATE INDEX IF NOT EXISTS idx_membership_org_state
      ON organization_memberships(organization_id,status,user_id);
    CREATE INDEX IF NOT EXISTS idx_membership_expiry
      ON organization_memberships(status,expires_at);

    CREATE TABLE IF NOT EXISTS organization_membership_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      membership_id INTEGER NOT NULL REFERENCES organization_memberships(id) ON DELETE RESTRICT,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      subject_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      actor_user_id INTEGER REFERENCES users(id),
      event_type TEXT NOT NULL CHECK(event_type IN
        ('membership_requested','membership_activated','membership_suspended',
         'membership_reactivated','membership_revoked','membership_expired')),
      from_status TEXT,
      to_status TEXT NOT NULL,
      occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_membership_events_org
      ON organization_membership_events(organization_id,id DESC);
    CREATE INDEX IF NOT EXISTS idx_membership_events_subject
      ON organization_membership_events(subject_user_id,id DESC);

    CREATE TRIGGER IF NOT EXISTS membership_identity_immutable
    BEFORE UPDATE OF organization_id,user_id,created_by ON organization_memberships
    BEGIN
      SELECT RAISE(ABORT, 'Membership identity is immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS membership_state_transition_guard
    BEFORE UPDATE OF status ON organization_memberships
    WHEN NOT (
      (OLD.status='pending' AND NEW.status IN ('active','revoked','expired')) OR
      (OLD.status='active' AND NEW.status IN ('suspended','revoked','expired')) OR
      (OLD.status='suspended' AND NEW.status IN ('active','revoked','expired'))
    )
    BEGIN
      SELECT RAISE(ABORT, 'Invalid or terminal membership state transition');
    END;

    CREATE TRIGGER IF NOT EXISTS membership_event_insert
    AFTER INSERT ON organization_memberships
    BEGIN
      INSERT INTO organization_membership_events
        (membership_id,organization_id,subject_user_id,actor_user_id,event_type,
         from_status,to_status)
      VALUES
        (NEW.id,NEW.organization_id,NEW.user_id,NEW.created_by,'membership_requested',
         NULL,NEW.status);
    END;

    CREATE TRIGGER IF NOT EXISTS membership_event_update
    AFTER UPDATE OF status ON organization_memberships
    WHEN OLD.status <> NEW.status
    BEGIN
      INSERT INTO organization_membership_events
        (membership_id,organization_id,subject_user_id,actor_user_id,event_type,
         from_status,to_status)
      VALUES
        (NEW.id,NEW.organization_id,NEW.user_id,NEW.updated_by,
         CASE
           WHEN NEW.status='active' AND OLD.status='suspended' THEN 'membership_reactivated'
           WHEN NEW.status='active' THEN 'membership_activated'
           WHEN NEW.status='suspended' THEN 'membership_suspended'
           WHEN NEW.status='revoked' THEN 'membership_revoked'
           WHEN NEW.status='expired' THEN 'membership_expired'
         END,
         OLD.status,NEW.status);
    END;

    CREATE TRIGGER IF NOT EXISTS membership_events_no_update
    BEFORE UPDATE ON organization_membership_events
    BEGIN SELECT RAISE(ABORT, 'Membership events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS membership_events_no_delete
    BEFORE DELETE ON organization_membership_events
    BEGIN SELECT RAISE(ABORT, 'Membership events are immutable'); END;
  `);
}

function requireActiveAdmin(database, actorUserId) {
  const actor = database.prepare(
    "SELECT id FROM users WHERE id=? AND active=1 AND role='admin'"
  ).get(actorUserId);
  if (!actor) throw new Error("An active administrator is required for this operation.");
}

function normalizeInstant(value, fieldName) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new TypeError(fieldName + " must be an ISO-8601 timestamp.");
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || !/[zZ]|[+-][0-9]{2}:[0-9]{2}$/.test(value)) {
    throw new TypeError(fieldName + " must include an explicit timezone.");
  }
  return parsed.toISOString();
}

export function createOrganization(database, { slug, name, actorUserId }) {
  requireActiveAdmin(database, actorUserId);
  if (typeof slug !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])$/i.test(slug.trim())) {
    throw new TypeError("Organization slug must be 2-80 letters, numbers, or internal hyphens.");
  }
  if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 200) {
    throw new TypeError("Organization name must contain 2-200 characters.");
  }
  const result = database.prepare(
    "INSERT INTO organizations(slug,name,created_by) VALUES(?,?,?)"
  ).run(slug.trim().toLowerCase(), name.trim(), actorUserId);
  return Number(result.lastInsertRowid);
}

export function requestOrganizationMembership(database, {
  organizationId, userId, actorUserId, startsAt = null, expiresAt = null
}) {
  requireActiveAdmin(database, actorUserId);
  const starts = normalizeInstant(startsAt, "startsAt");
  const expires = normalizeInstant(expiresAt, "expiresAt");
  if (starts && expires && Date.parse(expires) <= Date.parse(starts)) {
    throw new RangeError("Membership expiry must be later than its start.");
  }
  const result = database.prepare(`
    INSERT INTO organization_memberships
      (organization_id,user_id,status,starts_at,expires_at,created_by)
    SELECT o.id,u.id,'pending',?,?,?
    FROM organizations o CROSS JOIN users u
    WHERE o.id=? AND o.status='active' AND u.id=? AND u.active=1
  `).run(starts, expires, actorUserId, organizationId, userId);
  if (result.changes !== 1) throw new Error("Active organization and active user are required.");
  return Number(result.lastInsertRowid);
}

export function transitionOrganizationMembership(database, {
  membershipId, nextStatus, actorUserId
}) {
  requireActiveAdmin(database, actorUserId);
  if (!ALLOWED_TRANSITIONS[nextStatus]) throw new TypeError("Unsupported membership state.");
  const transition = database.transaction(() => {
    const current = database.prepare(
      "SELECT id,status,organization_id,user_id FROM organization_memberships WHERE id=?"
    ).get(membershipId);
    if (!current) throw new Error("Membership not found.");
    if (!ALLOWED_TRANSITIONS[current.status].has(nextStatus)) {
      throw new Error("Membership transition is not permitted.");
    }
    if (nextStatus === "active") {
      const eligible = database.prepare(`
        SELECT 1 FROM organizations o JOIN users u ON u.id=?
        WHERE o.id=? AND o.status='active' AND u.active=1
      `).get(current.user_id, current.organization_id);
      if (!eligible) throw new Error("Membership requires an active organization and active user.");
    }
    const revokedAt = nextStatus === "revoked" ? new Date().toISOString() : null;
    const result = database.prepare(`
      UPDATE organization_memberships
      SET status=?,approved_by=CASE WHEN ?='active' THEN ? ELSE approved_by END,
          updated_by=?,revoked_at=CASE WHEN ?='revoked' THEN ? ELSE revoked_at END,
          updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status=?
    `).run(nextStatus, nextStatus, actorUserId, actorUserId, nextStatus, revokedAt,
      membershipId, current.status);
    if (result.changes !== 1) throw new Error("Membership changed concurrently; retry authorization.");
    return { id: current.id, organizationId: current.organization_id,
      userId: current.user_id, previousStatus: current.status, status: nextStatus };
  });
  return transition.immediate();
}

export function hasActiveOrganizationMembership(database, userId, organizationId, at = new Date()) {
  const instant = at instanceof Date ? at.toISOString() : normalizeInstant(at, "at");
  return Boolean(database.prepare(`
    SELECT 1
    FROM organization_memberships m
    JOIN organizations o ON o.id=m.organization_id AND o.status='active'
    JOIN users u ON u.id=m.user_id AND u.active=1
    WHERE m.user_id=? AND m.organization_id=? AND m.status='active'
      AND (m.starts_at IS NULL OR julianday(m.starts_at)<=julianday(?))
      AND (m.expires_at IS NULL OR julianday(m.expires_at)>julianday(?))
    LIMIT 1
  `).get(userId, organizationId, instant, instant));
}

export function expireOrganizationMemberships(database, { at = new Date(), actorUserId = null } = {}) {
  const instant = at instanceof Date ? at.toISOString() : normalizeInstant(at, "at");
  const expire = database.transaction(() => database.prepare(`
    UPDATE organization_memberships
    SET status='expired',updated_by=?,updated_at=CURRENT_TIMESTAMP
    WHERE status IN ('pending','active','suspended')
      AND expires_at IS NOT NULL AND julianday(expires_at)<=julianday(?)
  `).run(actorUserId, instant));
  return expire.immediate().changes;
}
