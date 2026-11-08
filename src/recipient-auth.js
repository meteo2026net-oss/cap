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

    CREATE TRIGGER IF NOT EXISTS organization_create_admin_guard
    BEFORE INSERT ON organizations
    WHEN NOT EXISTS (
      SELECT 1 FROM users u WHERE u.id=NEW.created_by AND u.active=1 AND u.role='admin'
    )
    BEGIN SELECT RAISE(ABORT, 'Active administrator required to create organization'); END;

    CREATE TRIGGER IF NOT EXISTS membership_create_admin_guard
    BEFORE INSERT ON organization_memberships
    WHEN NEW.status <> 'pending'
      OR NOT EXISTS (
        SELECT 1 FROM users actor WHERE actor.id=NEW.created_by AND actor.active=1 AND actor.role='admin'
      )
      OR NOT EXISTS (
        SELECT 1 FROM users subject WHERE subject.id=NEW.user_id AND subject.active=1
      )
      OR NOT EXISTS (
        SELECT 1 FROM organizations org WHERE org.id=NEW.organization_id AND org.status='active'
      )
    BEGIN SELECT RAISE(ABORT, 'Pending membership requires an active administrator, user, and organization'); END;

    CREATE TRIGGER IF NOT EXISTS membership_update_admin_guard
    BEFORE UPDATE OF status ON organization_memberships
    WHEN (NEW.status <> 'expired' AND NOT EXISTS (
        SELECT 1 FROM users actor WHERE actor.id=NEW.updated_by AND actor.active=1 AND actor.role='admin'
      ))
      OR (NEW.status='active' AND NOT EXISTS (
        SELECT 1 FROM users approver WHERE approver.id=NEW.approved_by AND approver.active=1 AND approver.role='admin'
      ))
      OR (NEW.status='expired' AND (
        OLD.expires_at IS NULL OR julianday(OLD.expires_at)>julianday('now')
      ))
    BEGIN SELECT RAISE(ABORT, 'Membership state change lacks valid authority or expiry'); END;

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

    CREATE UNIQUE INDEX IF NOT EXISTS idx_membership_id_org_user
      ON organization_memberships(id,organization_id,user_id);

    CREATE TABLE IF NOT EXISTS recipient_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','archived')),
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(organization_id,slug),
      UNIQUE(id,organization_id),
      CHECK(length(trim(slug)) BETWEEN 2 AND 80),
      CHECK(length(trim(name)) BETWEEN 2 AND 200)
    );

    CREATE TABLE IF NOT EXISTS recipient_group_memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      organization_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      organization_membership_id INTEGER NOT NULL,
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
      FOREIGN KEY(group_id,organization_id)
        REFERENCES recipient_groups(id,organization_id) ON DELETE RESTRICT,
      FOREIGN KEY(organization_membership_id,organization_id,user_id)
        REFERENCES organization_memberships(id,organization_id,user_id) ON DELETE RESTRICT,
      CHECK(expires_at IS NULL OR starts_at IS NULL OR julianday(expires_at)>julianday(starts_at)),
      CHECK(status <> 'active' OR approved_by IS NOT NULL),
      CHECK(status <> 'revoked' OR revoked_at IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_group_membership_one_open_period
      ON recipient_group_memberships(group_id,user_id)
      WHERE status IN ('pending','active','suspended');
    CREATE INDEX IF NOT EXISTS idx_group_membership_lookup
      ON recipient_group_memberships(user_id,organization_id,status,group_id);
    CREATE INDEX IF NOT EXISTS idx_group_membership_expiry
      ON recipient_group_memberships(status,expires_at);

    CREATE TABLE IF NOT EXISTS recipient_group_membership_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_membership_id INTEGER NOT NULL REFERENCES recipient_group_memberships(id) ON DELETE RESTRICT,
      group_id INTEGER NOT NULL,
      organization_id INTEGER NOT NULL,
      subject_user_id INTEGER NOT NULL REFERENCES users(id),
      actor_user_id INTEGER REFERENCES users(id),
      event_type TEXT NOT NULL CHECK(event_type IN
        ('group_membership_requested','group_membership_activated','group_membership_suspended',
         'group_membership_reactivated','group_membership_revoked','group_membership_expired')),
      from_status TEXT,
      to_status TEXT NOT NULL,
      occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(group_id,organization_id)
        REFERENCES recipient_groups(id,organization_id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_group_membership_events_org
      ON recipient_group_membership_events(organization_id,id DESC);


    CREATE TABLE IF NOT EXISTS alert_recipient_grants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
      owner_organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      recipient_type TEXT NOT NULL CHECK(recipient_type IN ('user','organization','group')),
      recipient_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
      recipient_organization_id INTEGER REFERENCES organizations(id) ON DELETE RESTRICT,
      recipient_group_id INTEGER,
      action TEXT NOT NULL CHECK(action IN ('read','deliver')),
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
      FOREIGN KEY(recipient_group_id,recipient_organization_id)
        REFERENCES recipient_groups(id,organization_id) ON DELETE RESTRICT,
      CHECK(owner_organization_id <> recipient_organization_id OR recipient_type='user'),
      CHECK(
        (recipient_type='user' AND recipient_user_id IS NOT NULL
          AND recipient_organization_id IS NULL AND recipient_group_id IS NULL) OR
        (recipient_type='organization' AND recipient_user_id IS NULL
          AND recipient_organization_id IS NOT NULL AND recipient_group_id IS NULL) OR
        (recipient_type='group' AND recipient_user_id IS NULL
          AND recipient_organization_id IS NOT NULL AND recipient_group_id IS NOT NULL)
      ),
      CHECK(expires_at IS NULL OR starts_at IS NULL OR julianday(expires_at)>julianday(starts_at)),
      CHECK(status <> 'active' OR approved_by IS NOT NULL),
      CHECK(status <> 'revoked' OR revoked_at IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_grant_one_open_target
      ON alert_recipient_grants(alert_id,recipient_type,
        COALESCE(recipient_user_id,0),COALESCE(recipient_organization_id,0),
        COALESCE(recipient_group_id,0),action)
      WHERE status IN ('pending','active','suspended');
    CREATE INDEX IF NOT EXISTS idx_alert_grant_lookup
      ON alert_recipient_grants(alert_id,status,action,expires_at);
    CREATE INDEX IF NOT EXISTS idx_alert_grant_recipient
      ON alert_recipient_grants(recipient_type,recipient_user_id,recipient_organization_id,recipient_group_id,status);

    CREATE TABLE IF NOT EXISTS alert_recipient_grant_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grant_id INTEGER NOT NULL REFERENCES alert_recipient_grants(id) ON DELETE RESTRICT,
      alert_id INTEGER NOT NULL REFERENCES alerts(id) ON DELETE RESTRICT,
      owner_organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
      actor_user_id INTEGER REFERENCES users(id),
      event_type TEXT NOT NULL CHECK(event_type IN
        ('grant_created','grant_activated','grant_suspended','grant_reactivated','grant_revoked','grant_expired')),
      from_status TEXT,
      to_status TEXT NOT NULL,
      occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_alert_grant_events_alert
      ON alert_recipient_grant_events(alert_id,id DESC);

    CREATE TRIGGER IF NOT EXISTS alert_grant_create_guard
    BEFORE INSERT ON alert_recipient_grants
    WHEN NEW.status <> 'pending'
      OR NOT EXISTS (
        SELECT 1 FROM users actor WHERE actor.id=NEW.created_by AND actor.active=1 AND actor.role='admin'
      )
      OR NOT EXISTS (
        SELECT 1 FROM alerts a WHERE a.id=NEW.alert_id
          AND a.owner_organization_id=NEW.owner_organization_id
      )
      OR NOT EXISTS (
        SELECT 1 FROM organizations owner WHERE owner.id=NEW.owner_organization_id AND owner.status='active'
      )
      OR (NEW.recipient_type='user' AND NOT EXISTS (
        SELECT 1 FROM organization_memberships m JOIN organizations o ON o.id=m.organization_id
        JOIN users u ON u.id=m.user_id
        WHERE m.user_id=NEW.recipient_user_id AND m.status='active'
          AND o.status='active' AND u.active=1
          AND (m.starts_at IS NULL OR julianday(m.starts_at)<=julianday('now'))
          AND (m.expires_at IS NULL OR julianday(m.expires_at)>julianday('now'))
      ))
      OR (NEW.recipient_type='organization' AND NOT EXISTS (
        SELECT 1 FROM organizations o WHERE o.id=NEW.recipient_organization_id
          AND o.status='active' AND o.id<>NEW.owner_organization_id
      ))
      OR (NEW.recipient_type='group' AND NOT EXISTS (
        SELECT 1 FROM recipient_groups g JOIN organizations o ON o.id=g.organization_id
        WHERE g.id=NEW.recipient_group_id
          AND g.organization_id=NEW.recipient_organization_id
          AND g.status='active' AND o.status='active'
          AND o.id<>NEW.owner_organization_id
      ))
    BEGIN SELECT RAISE(ABORT, 'Grant requires active administrator, owned alert, and valid recipient'); END;

    CREATE TRIGGER IF NOT EXISTS alert_grant_update_guard
    BEFORE UPDATE OF status ON alert_recipient_grants
    WHEN (NEW.status <> 'expired' AND NOT EXISTS (
        SELECT 1 FROM users actor WHERE actor.id=NEW.updated_by AND actor.active=1 AND actor.role='admin'
      ))
      OR (NEW.status='active' AND NOT EXISTS (
        SELECT 1 FROM users approver WHERE approver.id=NEW.approved_by AND approver.active=1 AND approver.role='admin'
      ))
      OR (NEW.status='expired' AND (
        OLD.expires_at IS NULL OR julianday(OLD.expires_at)>julianday('now')
      ))
    BEGIN SELECT RAISE(ABORT, 'Grant state change lacks valid authority or expiry'); END;

    CREATE TRIGGER IF NOT EXISTS alert_grant_identity_immutable
    BEFORE UPDATE OF alert_id,owner_organization_id,recipient_type,recipient_user_id,
      recipient_organization_id,recipient_group_id,action,created_by ON alert_recipient_grants
    BEGIN SELECT RAISE(ABORT, 'Grant identity is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS alert_grant_state_transition_guard
    BEFORE UPDATE OF status ON alert_recipient_grants
    WHEN NOT (
      (OLD.status='pending' AND NEW.status IN ('active','revoked','expired')) OR
      (OLD.status='active' AND NEW.status IN ('suspended','revoked','expired')) OR
      (OLD.status='suspended' AND NEW.status IN ('active','revoked','expired'))
    )
    BEGIN SELECT RAISE(ABORT, 'Invalid or terminal grant state transition'); END;

    CREATE TRIGGER IF NOT EXISTS alert_grant_event_insert
    AFTER INSERT ON alert_recipient_grants
    BEGIN
      INSERT INTO alert_recipient_grant_events
        (grant_id,alert_id,owner_organization_id,actor_user_id,event_type,from_status,to_status)
      VALUES(NEW.id,NEW.alert_id,NEW.owner_organization_id,NEW.created_by,'grant_created',NULL,NEW.status);
    END;
    CREATE TRIGGER IF NOT EXISTS alert_grant_event_update
    AFTER UPDATE OF status ON alert_recipient_grants
    WHEN OLD.status <> NEW.status
    BEGIN
      INSERT INTO alert_recipient_grant_events
        (grant_id,alert_id,owner_organization_id,actor_user_id,event_type,from_status,to_status)
      VALUES(NEW.id,NEW.alert_id,NEW.owner_organization_id,NEW.updated_by,
        CASE
          WHEN NEW.status='active' AND OLD.status='suspended' THEN 'grant_reactivated'
          WHEN NEW.status='active' THEN 'grant_activated'
          WHEN NEW.status='suspended' THEN 'grant_suspended'
          WHEN NEW.status='revoked' THEN 'grant_revoked'
          WHEN NEW.status='expired' THEN 'grant_expired'
        END,OLD.status,NEW.status);
    END;
    CREATE TRIGGER IF NOT EXISTS alert_grant_events_no_update
    BEFORE UPDATE ON alert_recipient_grant_events
    BEGIN SELECT RAISE(ABORT, 'Grant events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS alert_grant_events_no_delete
    BEFORE DELETE ON alert_recipient_grant_events
    BEGIN SELECT RAISE(ABORT, 'Grant events are immutable'); END;

    CREATE TRIGGER IF NOT EXISTS recipient_group_create_admin_guard
    BEFORE INSERT ON recipient_groups
    WHEN NOT EXISTS (
      SELECT 1 FROM users actor WHERE actor.id=NEW.created_by AND actor.active=1 AND actor.role='admin'
    ) OR NOT EXISTS (
      SELECT 1 FROM organizations org WHERE org.id=NEW.organization_id AND org.status='active'
    )
    BEGIN SELECT RAISE(ABORT, 'Active administrator and organization required to create recipient group'); END;

    CREATE TRIGGER IF NOT EXISTS group_membership_create_guard
    BEFORE INSERT ON recipient_group_memberships
    WHEN NEW.status <> 'pending'
      OR NOT EXISTS (
        SELECT 1 FROM users actor WHERE actor.id=NEW.created_by AND actor.active=1 AND actor.role='admin'
      )
      OR NOT EXISTS (
        SELECT 1 FROM recipient_groups g WHERE g.id=NEW.group_id
          AND g.organization_id=NEW.organization_id AND g.status='active'
      )
      OR NOT EXISTS (
        SELECT 1 FROM organization_memberships m JOIN organizations o ON o.id=m.organization_id
        JOIN users u ON u.id=m.user_id
        WHERE m.id=NEW.organization_membership_id AND m.organization_id=NEW.organization_id
          AND m.user_id=NEW.user_id AND m.status='active' AND o.status='active' AND u.active=1
          AND (m.starts_at IS NULL OR julianday(m.starts_at)<=julianday('now'))
          AND (m.expires_at IS NULL OR julianday(m.expires_at)>julianday('now'))
      )
    BEGIN SELECT RAISE(ABORT, 'Group membership requires active administrator, group, and organization membership'); END;

    CREATE TRIGGER IF NOT EXISTS group_membership_update_guard
    BEFORE UPDATE OF status ON recipient_group_memberships
    WHEN (NEW.status <> 'expired' AND NOT EXISTS (
        SELECT 1 FROM users actor WHERE actor.id=NEW.updated_by AND actor.active=1 AND actor.role='admin'
      ))
      OR (NEW.status='active' AND NOT EXISTS (
        SELECT 1 FROM users approver WHERE approver.id=NEW.approved_by AND approver.active=1 AND approver.role='admin'
      ))
      OR (NEW.status='expired' AND (
        OLD.expires_at IS NULL OR julianday(OLD.expires_at)>julianday('now')
      ))
    BEGIN SELECT RAISE(ABORT, 'Group membership state change lacks valid authority or expiry'); END;

    CREATE TRIGGER IF NOT EXISTS group_membership_identity_immutable
    BEFORE UPDATE OF group_id,organization_id,user_id,organization_membership_id,created_by
      ON recipient_group_memberships
    BEGIN SELECT RAISE(ABORT, 'Group membership identity is immutable'); END;

    CREATE TRIGGER IF NOT EXISTS group_membership_state_transition_guard
    BEFORE UPDATE OF status ON recipient_group_memberships
    WHEN NOT (
      (OLD.status='pending' AND NEW.status IN ('active','revoked','expired')) OR
      (OLD.status='active' AND NEW.status IN ('suspended','revoked','expired')) OR
      (OLD.status='suspended' AND NEW.status IN ('active','revoked','expired'))
    )
    BEGIN SELECT RAISE(ABORT, 'Invalid or terminal group membership state transition'); END;

    CREATE TRIGGER IF NOT EXISTS group_membership_event_insert
    AFTER INSERT ON recipient_group_memberships
    BEGIN
      INSERT INTO recipient_group_membership_events
        (group_membership_id,group_id,organization_id,subject_user_id,actor_user_id,
         event_type,from_status,to_status)
      VALUES(NEW.id,NEW.group_id,NEW.organization_id,NEW.user_id,NEW.created_by,
        'group_membership_requested',NULL,NEW.status);
    END;

    CREATE TRIGGER IF NOT EXISTS group_membership_event_update
    AFTER UPDATE OF status ON recipient_group_memberships
    WHEN OLD.status <> NEW.status
    BEGIN
      INSERT INTO recipient_group_membership_events
        (group_membership_id,group_id,organization_id,subject_user_id,actor_user_id,
         event_type,from_status,to_status)
      VALUES(NEW.id,NEW.group_id,NEW.organization_id,NEW.user_id,NEW.updated_by,
        CASE
          WHEN NEW.status='active' AND OLD.status='suspended' THEN 'group_membership_reactivated'
          WHEN NEW.status='active' THEN 'group_membership_activated'
          WHEN NEW.status='suspended' THEN 'group_membership_suspended'
          WHEN NEW.status='revoked' THEN 'group_membership_revoked'
          WHEN NEW.status='expired' THEN 'group_membership_expired'
        END,OLD.status,NEW.status);
    END;

    CREATE TRIGGER IF NOT EXISTS group_membership_events_no_update
    BEFORE UPDATE ON recipient_group_membership_events
    BEGIN SELECT RAISE(ABORT, 'Group membership events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS group_membership_events_no_delete
    BEFORE DELETE ON recipient_group_membership_events
    BEGIN SELECT RAISE(ABORT, 'Group membership events are immutable'); END;
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
  if (typeof slug !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])$/i.test(slug.trim())) {
    throw new TypeError("Organization slug must be 2-80 letters, numbers, or internal hyphens.");
  }
  if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 200) {
    throw new TypeError("Organization name must contain 2-200 characters.");
  }
  const create = database.transaction(() => {
    requireActiveAdmin(database, actorUserId);
    const result = database.prepare(
      "INSERT INTO organizations(slug,name,created_by) VALUES(?,?,?)"
    ).run(slug.trim().toLowerCase(), name.trim(), actorUserId);
    return Number(result.lastInsertRowid);
  });
  return create.immediate();
}

export function requestOrganizationMembership(database, {
  organizationId, userId, actorUserId, startsAt = null, expiresAt = null
}) {
  const starts = normalizeInstant(startsAt, "startsAt");
  const expires = normalizeInstant(expiresAt, "expiresAt");
  if (starts && expires && Date.parse(expires) <= Date.parse(starts)) {
    throw new RangeError("Membership expiry must be later than its start.");
  }
  const request = database.transaction(() => {
    requireActiveAdmin(database, actorUserId);
    const result = database.prepare(`
      INSERT INTO organization_memberships
        (organization_id,user_id,status,starts_at,expires_at,created_by)
      SELECT o.id,u.id,'pending',?,?,?
      FROM organizations o CROSS JOIN users u
      WHERE o.id=? AND o.status='active' AND u.id=? AND u.active=1
    `).run(starts, expires, actorUserId, organizationId, userId);
    if (result.changes !== 1) throw new Error("Active organization and active user are required.");
    return Number(result.lastInsertRowid);
  });
  return request.immediate();
}

export function transitionOrganizationMembership(database, {
  membershipId, nextStatus, actorUserId
}) {
  if (!ALLOWED_TRANSITIONS[nextStatus] || nextStatus === "expired") throw new TypeError("Expiry is system-managed; use the expiry sweep.");
  const transition = database.transaction(() => {
    requireActiveAdmin(database, actorUserId);
    const current = database.prepare(
      "SELECT id,status,organization_id,user_id,expires_at FROM organization_memberships WHERE id=?"
    ).get(membershipId);
    if (!current) throw new Error("Membership not found.");
    if (!ALLOWED_TRANSITIONS[current.status].has(nextStatus)) {
      throw new Error("Membership transition is not permitted.");
    }
    if (nextStatus === "active") {
      const eligible = database.prepare(`
        SELECT 1 FROM organizations o JOIN users u ON u.id=?
        WHERE o.id=? AND o.status='active' AND u.active=1
          AND (? IS NULL OR julianday(?)>julianday('now'))
      `).get(current.user_id, current.organization_id, current.expires_at, current.expires_at);
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


export function createRecipientGroup(database, { organizationId, slug, name, actorUserId }) {
  if (typeof slug !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])$/i.test(slug.trim())) {
    throw new TypeError("Recipient group slug must be 2-80 letters, numbers, or internal hyphens.");
  }
  if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > 200) {
    throw new TypeError("Recipient group name must contain 2-200 characters.");
  }
  const create = database.transaction(() => {
    requireActiveAdmin(database, actorUserId);
    const result = database.prepare(`
      INSERT INTO recipient_groups(organization_id,slug,name,created_by)
      SELECT id,?,?,? FROM organizations WHERE id=? AND status='active'
    `).run(slug.trim().toLowerCase(), name.trim(), actorUserId, organizationId);
    if (result.changes !== 1) throw new Error("Active organization not found.");
    return Number(result.lastInsertRowid);
  });
  return create.immediate();
}

export function requestRecipientGroupMembership(database, {
  groupId, organizationMembershipId, actorUserId, startsAt = null, expiresAt = null
}) {
  const starts = normalizeInstant(startsAt, "startsAt");
  const expires = normalizeInstant(expiresAt, "expiresAt");
  if (starts && expires && Date.parse(expires) <= Date.parse(starts)) {
    throw new RangeError("Group membership expiry must be later than its start.");
  }
  const request = database.transaction(() => {
    requireActiveAdmin(database, actorUserId);
    const result = database.prepare(`
      INSERT INTO recipient_group_memberships
        (group_id,organization_id,user_id,organization_membership_id,status,
         starts_at,expires_at,created_by)
      SELECT g.id,g.organization_id,m.user_id,m.id,'pending',?,?,?
      FROM recipient_groups g
      JOIN organization_memberships m ON m.organization_id=g.organization_id
      JOIN organizations o ON o.id=g.organization_id
      JOIN users u ON u.id=m.user_id
      WHERE g.id=? AND g.status='active' AND o.status='active'
        AND m.id=? AND m.status='active' AND u.active=1
        AND (m.starts_at IS NULL OR julianday(m.starts_at)<=julianday('now'))
        AND (m.expires_at IS NULL OR julianday(m.expires_at)>julianday('now'))
    `).run(starts, expires, actorUserId, groupId, organizationMembershipId);
    if (result.changes !== 1) throw new Error("Active group and matching organization membership are required.");
    return Number(result.lastInsertRowid);
  });
  return request.immediate();
}

export function transitionRecipientGroupMembership(database, {
  membershipId, nextStatus, actorUserId
}) {
  if (!ALLOWED_TRANSITIONS[nextStatus] || nextStatus === "expired") {
    throw new TypeError("Expiry is system-managed; use the expiry sweep.");
  }
  const transition = database.transaction(() => {
    requireActiveAdmin(database, actorUserId);
    const current = database.prepare(`
      SELECT gm.id,gm.status,gm.group_id,gm.organization_id,gm.user_id,
        gm.organization_membership_id,gm.expires_at
      FROM recipient_group_memberships gm WHERE gm.id=?
    `).get(membershipId);
    if (!current) throw new Error("Group membership not found.");
    if (!ALLOWED_TRANSITIONS[current.status].has(nextStatus)) {
      throw new Error("Group membership transition is not permitted.");
    }
    if (nextStatus === "active") {
      const eligible = database.prepare(`
        SELECT 1 FROM recipient_groups g
        JOIN organizations o ON o.id=g.organization_id
        JOIN organization_memberships m ON m.id=?
        JOIN users u ON u.id=m.user_id
        WHERE g.id=? AND g.organization_id=? AND g.status='active' AND o.status='active'
          AND m.organization_id=? AND m.user_id=? AND m.status='active' AND u.active=1
          AND (m.starts_at IS NULL OR julianday(m.starts_at)<=julianday('now'))
          AND (m.expires_at IS NULL OR julianday(m.expires_at)>julianday('now'))
          AND (? IS NULL OR julianday(?)>julianday('now'))
      `).get(current.organization_membership_id,current.group_id,current.organization_id,
        current.organization_id,current.user_id,current.expires_at,current.expires_at);
      if (!eligible) throw new Error("Group membership requires active group and organization membership.");
    }
    const revokedAt = nextStatus === "revoked" ? new Date().toISOString() : null;
    const result = database.prepare(`
      UPDATE recipient_group_memberships
      SET status=?,approved_by=CASE WHEN ?='active' THEN ? ELSE approved_by END,
        updated_by=?,revoked_at=CASE WHEN ?='revoked' THEN ? ELSE revoked_at END,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status=?
    `).run(nextStatus,nextStatus,actorUserId,actorUserId,nextStatus,revokedAt,
      membershipId,current.status);
    if (result.changes !== 1) throw new Error("Group membership changed concurrently; retry authorization.");
    return { id:current.id,groupId:current.group_id,organizationId:current.organization_id,
      userId:current.user_id,previousStatus:current.status,status:nextStatus };
  });
  return transition.immediate();
}

export function hasActiveRecipientGroupMembership(database, userId, organizationId, groupId, at = new Date()) {
  const instant = at instanceof Date ? at.toISOString() : normalizeInstant(at, "at");
  return Boolean(database.prepare(`
    SELECT 1
    FROM recipient_group_memberships gm
    JOIN recipient_groups g ON g.id=gm.group_id AND g.organization_id=gm.organization_id
    JOIN organization_memberships m ON m.id=gm.organization_membership_id
      AND m.organization_id=gm.organization_id AND m.user_id=gm.user_id
    JOIN organizations o ON o.id=gm.organization_id AND o.status='active'
    JOIN users u ON u.id=gm.user_id AND u.active=1
    WHERE gm.user_id=? AND gm.organization_id=? AND gm.group_id=?
      AND gm.status='active' AND g.status='active'
      AND m.status='active'
      AND (m.starts_at IS NULL OR julianday(m.starts_at)<=julianday(?))
      AND (m.expires_at IS NULL OR julianday(m.expires_at)>julianday(?))
      AND (gm.starts_at IS NULL OR julianday(gm.starts_at)<=julianday(?))
      AND (gm.expires_at IS NULL OR julianday(gm.expires_at)>julianday(?))
    LIMIT 1
  `).get(userId,organizationId,groupId,instant,instant,instant,instant));
}

export function expireRecipientGroupMemberships(database, { at = new Date(), actorUserId = null } = {}) {
  const instant = at instanceof Date ? at.toISOString() : normalizeInstant(at, "at");
  const expire = database.transaction(() => database.prepare(`
    UPDATE recipient_group_memberships
    SET status='expired',updated_by=?,updated_at=CURRENT_TIMESTAMP
    WHERE status IN ('pending','active','suspended')
      AND expires_at IS NOT NULL AND julianday(expires_at)<=julianday(?)
  `).run(actorUserId,instant));
  return expire.immediate().changes;
}
