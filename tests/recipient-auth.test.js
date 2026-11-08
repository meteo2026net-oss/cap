import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  alertRecipientGrantSql,
  assignAlertOrganizationOwner,
  createAlertRecipientGrant,
  createOrganization,
  createRecipientGroup,
  expireAlertRecipientGrants,
  expireOrganizationMemberships,
  hasActiveAlertRecipientGrant,
  hasActiveOrganizationMembership,
  listActiveOrganizationIds,
  hasActiveRecipientGroupMembership,
  installRecipientSchema,
  requestOrganizationMembership,
  requestRecipientGroupMembership,
  transitionAlertRecipientGrant,
  transitionOrganizationMembership,
  transitionRecipientGroupMembership
} from "../src/recipient-auth.js";

function fixture() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','forecaster','reviewer','approver','publisher','viewer')),
      active INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO users(id,username,password_hash,role,active) VALUES
      (1,'admin','x','admin',1),
      (2,'a_forecaster','x','forecaster',1),
      (3,'b_forecaster','x','forecaster',1),
      (4,'inactive_forecaster','x','forecaster',0);
    CREATE TABLE alerts (
      id INTEGER PRIMARY KEY,
      owner_organization_id INTEGER REFERENCES organizations(id),
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  installRecipientSchema(database);
  return database;
}

test("organization memberships support multiple organizations without cross-tenant identity substitution", () => {
  const database = fixture();
  try {
    const orgA = createOrganization(database, { slug: "org-a", name: "Organization A", actorUserId: 1 });
    const orgB = createOrganization(database, { slug: "org-b", name: "Organization B", actorUserId: 1 });
    const memberA = requestOrganizationMembership(database, { organizationId: orgA, userId: 2, actorUserId: 1 });
    const memberB = requestOrganizationMembership(database, { organizationId: orgB, userId: 3, actorUserId: 1 });
    assert.equal(database.prepare("SELECT status FROM organization_memberships WHERE id=?").get(memberA).status, "pending");
    assert.throws(() => requestOrganizationMembership(database, {
      organizationId: orgA, userId: 4, actorUserId: 1
    }), /active organization and active user/i);
    assert.throws(() => requestOrganizationMembership(database, {
      organizationId: orgA, userId: 2, actorUserId: 1
    }), /UNIQUE/);
    transitionOrganizationMembership(database, { membershipId: memberA, nextStatus: "active", actorUserId: 1 });
    transitionOrganizationMembership(database, { membershipId: memberB, nextStatus: "active", actorUserId: 1 });
    assert.equal(hasActiveOrganizationMembership(database, 2, orgA), true);
    assert.equal(hasActiveOrganizationMembership(database, 2, orgB), false);
    assert.equal(hasActiveOrganizationMembership(database, 3, orgB), true);
    assert.equal(hasActiveOrganizationMembership(database, 3, orgA), false);
  } finally {
    database.close();
  }
});

test("active organization ID listing applies the same current-membership window as point checks", () => {
  const database = fixture();
  try {
    const futureOrg = createOrganization(database, { slug: "future-window", name: "Future Window", actorUserId: 1 });
    const expiringOrg = createOrganization(database, { slug: "expiring-window", name: "Expiring Window", actorUserId: 1 });
    const now = Date.now();
    const futureStart = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    const pastStart = new Date(now - 60 * 60 * 1000).toISOString();
    const expiry = new Date(now + 24 * 60 * 60 * 1000).toISOString();
    const futureMembership = requestOrganizationMembership(database, {
      organizationId: futureOrg, userId: 2, actorUserId: 1, startsAt: futureStart
    });
    const expiringMembership = requestOrganizationMembership(database, {
      organizationId: expiringOrg, userId: 3, actorUserId: 1,
      startsAt: pastStart, expiresAt: expiry
    });
    transitionOrganizationMembership(database, { membershipId: futureMembership, nextStatus: "active", actorUserId: 1 });
    transitionOrganizationMembership(database, { membershipId: expiringMembership, nextStatus: "active", actorUserId: 1 });

    assert.deepEqual(listActiveOrganizationIds(database, 2, new Date(now)), []);
    assert.equal(hasActiveOrganizationMembership(database, 2, futureOrg, new Date(now)), false);
    assert.deepEqual(listActiveOrganizationIds(database, 3, new Date(now)), [expiringOrg]);
    assert.equal(hasActiveOrganizationMembership(database, 3, expiringOrg, new Date(now)), true);

    const afterWindow = new Date(now + 2 * 24 * 60 * 60 * 1000);
    assert.deepEqual(listActiveOrganizationIds(database, 2, afterWindow), [futureOrg]);
    assert.equal(hasActiveOrganizationMembership(database, 3, expiringOrg, afterWindow), false);
    assert.deepEqual(listActiveOrganizationIds(database, 3, afterWindow), []);
  } finally {
    database.close();
  }
});

test("membership lifecycle is audited and terminal revocation cannot be resurrected", () => {
  const database = fixture();
  try {
    const org = createOrganization(database, { slug: "lifecycle", name: "Lifecycle Org", actorUserId: 1 });
    const membershipId = requestOrganizationMembership(database, { organizationId: org, userId: 2, actorUserId: 1 });
    transitionOrganizationMembership(database, { membershipId, nextStatus: "active", actorUserId: 1 });
    transitionOrganizationMembership(database, { membershipId, nextStatus: "suspended", actorUserId: 1 });
    assert.equal(hasActiveOrganizationMembership(database, 2, org), false);
    transitionOrganizationMembership(database, { membershipId, nextStatus: "active", actorUserId: 1 });
    transitionOrganizationMembership(database, { membershipId, nextStatus: "revoked", actorUserId: 1 });
    assert.equal(hasActiveOrganizationMembership(database, 2, org), false);
    assert.throws(() => transitionOrganizationMembership(database, {
      membershipId, nextStatus: "active", actorUserId: 1
    }), /not permitted/);
    const events = database.prepare(
      "SELECT event_type,from_status,to_status FROM organization_membership_events WHERE membership_id=? ORDER BY id"
    ).all(membershipId);
    assert.deepEqual(events.map(event => event.event_type), [
      "membership_requested","membership_activated","membership_suspended",
      "membership_reactivated","membership_revoked"
    ]);
    assert.throws(() => database.prepare(
      "UPDATE organization_membership_events SET to_status='active' WHERE membership_id=?"
    ).run(membershipId), /immutable/);
  } finally {
    database.close();
  }
});

test("membership expiry is enforced at authorization time and by expiry sweep", async () => {
  const database = fixture();
  try {
    const org = createOrganization(database, { slug: "expiry", name: "Expiry Org", actorUserId: 1 });
    const expiresAt = new Date(Date.now() + 1500);
    const membershipId = requestOrganizationMembership(database, {
      organizationId: org, userId: 2, actorUserId: 1,
      startsAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      expiresAt: expiresAt.toISOString()
    });
    transitionOrganizationMembership(database, { membershipId, nextStatus: "active", actorUserId: 1 });
    assert.equal(hasActiveOrganizationMembership(database, 2, org, new Date(Date.now() + 500)), true);
    assert.equal(hasActiveOrganizationMembership(database, 2, org, expiresAt), false);
    await new Promise(resolve => setTimeout(resolve, 1600));
    assert.equal(expireOrganizationMemberships(database, { at: expiresAt }), 1);
    assert.equal(database.prepare("SELECT status FROM organization_memberships WHERE id=?").get(membershipId).status, "expired");
  } finally {
    database.close();
  }
});

test("membership mutations require an active administrator and reject invalid windows", () => {
  const database = fixture();
  try {
    assert.throws(() => createOrganization(database, {
      slug: "bad-org", name: "Bad Org", actorUserId: 2
    }), /active administrator/);
    const org = createOrganization(database, { slug: "valid-org", name: "Valid Org", actorUserId: 1 });
    assert.throws(() => requestOrganizationMembership(database, {
      organizationId: org, userId: 2, actorUserId: 1,
      startsAt: "2026-11-03T00:00:00Z", expiresAt: "2026-11-02T00:00:00Z"
    }), /later than its start/);
    assert.throws(() => requestOrganizationMembership(database, {
      organizationId: org, userId: 2, actorUserId: 2
    }), /active administrator/);
  } finally {
    database.close();
  }
});


test("SQLite guards reject forged membership actors and premature expiry", () => {
  const database = fixture();
  try {
    assert.throws(() => database.prepare(
      "INSERT INTO organizations(slug,name,created_by) VALUES('forged-org','Forged Org',2)"
    ).run(), /Active administrator required/);
    const org = createOrganization(database, { slug: "guarded-org", name: "Guarded Org", actorUserId: 1 });
    assert.throws(() => database.prepare(`
      INSERT INTO organization_memberships
        (organization_id,user_id,status,created_by)
      VALUES(?,2,'pending',2)
    `).run(org), /Pending membership requires an active administrator/);
    const membershipId = requestOrganizationMembership(database, {
      organizationId: org, userId: 2, actorUserId: 1,
      expiresAt: "2030-01-01T00:00:00Z"
    });
    assert.throws(() => database.prepare(`
      UPDATE organization_memberships SET status='active',approved_by=2,updated_by=2
      WHERE id=?
    `).run(membershipId), /Membership state change lacks valid authority/);
    assert.throws(() => database.prepare(`
      UPDATE organization_memberships SET status='expired',updated_by=NULL
      WHERE id=?
    `).run(membershipId), /Membership state change lacks valid authority or expiry/);
  } finally {
    database.close();
  }
});


test("recipient groups are organization-bound and require a live matching organization membership", () => {
  const database = fixture();
  try {
    const orgA = createOrganization(database, { slug: "group-org-a", name: "Group Org A", actorUserId: 1 });
    const orgB = createOrganization(database, { slug: "group-org-b", name: "Group Org B", actorUserId: 1 });
    const memberA = requestOrganizationMembership(database, { organizationId: orgA, userId: 2, actorUserId: 1 });
    const memberB = requestOrganizationMembership(database, { organizationId: orgB, userId: 3, actorUserId: 1 });
    transitionOrganizationMembership(database, { membershipId: memberA, nextStatus: "active", actorUserId: 1 });
    transitionOrganizationMembership(database, { membershipId: memberB, nextStatus: "active", actorUserId: 1 });
    const groupA = createRecipientGroup(database, {
      organizationId: orgA, slug: "ops", name: "Operations", actorUserId: 1
    });
    const groupB = createRecipientGroup(database, {
      organizationId: orgB, slug: "ops", name: "Operations", actorUserId: 1
    });
    assert.notEqual(groupA, groupB, "group slugs are scoped to their owning organization");
    assert.throws(() => requestRecipientGroupMembership(database, {
      groupId: groupA, organizationMembershipId: memberB, actorUserId: 1
    }), /Active group and matching organization membership/);
    const groupMemberB = requestRecipientGroupMembership(database, {
      groupId: groupB, organizationMembershipId: memberB, actorUserId: 1
    });
    transitionRecipientGroupMembership(database, {
      membershipId: groupMemberB, nextStatus: "active", actorUserId: 1
    });
    assert.equal(hasActiveRecipientGroupMembership(database, 3, orgB, groupB), true);
    assert.equal(hasActiveRecipientGroupMembership(database, 3, orgA, groupA), false);
    transitionOrganizationMembership(database, { membershipId: memberB, nextStatus: "revoked", actorUserId: 1 });
    assert.equal(hasActiveRecipientGroupMembership(database, 3, orgB, groupB), false,
      "a group membership cannot outlive its parent organization membership");
  } finally {
    database.close();
  }
});


test("alert grants bind direct users, organizations, and groups to an alert owner and enforce lifecycle", () => {
  const database=fixture();
  try {
    const owner=createOrganization(database,{slug:"grant-owner",name:"Grant Owner",actorUserId:1});
    const recipient=createOrganization(database,{slug:"grant-recipient",name:"Grant Recipient",actorUserId:1});
    const member=requestOrganizationMembership(database,{organizationId:recipient,userId:3,actorUserId:1});
    const sameRolePeer=requestOrganizationMembership(database,{organizationId:owner,userId:2,actorUserId:1});
    transitionOrganizationMembership(database,{membershipId:member,nextStatus:"active",actorUserId:1});
    transitionOrganizationMembership(database,{membershipId:sameRolePeer,nextStatus:"active",actorUserId:1});
    const group=createRecipientGroup(database,{organizationId:recipient,slug:"ops",name:"Operations",actorUserId:1});
    const groupMember=requestRecipientGroupMembership(database,{groupId:group,organizationMembershipId:member,actorUserId:1});
    transitionRecipientGroupMembership(database,{membershipId:groupMember,nextStatus:"active",actorUserId:1});
    database.prepare("INSERT INTO alerts(id) VALUES(100)").run();
    assignAlertOrganizationOwner(database,{alertId:100,organizationId:owner,actorUserId:1});

    const direct=createAlertRecipientGrant(database,{
      alertId:100,ownerOrganizationId:owner,recipientType:"user",recipientUserId:3,
      recipientOrganizationId:recipient,action:"read",actorUserId:1
    });
    transitionAlertRecipientGrant(database,{grantId:direct,nextStatus:"active",actorUserId:1});
    assert.equal(hasActiveAlertRecipientGrant(database,{
      alertId:100,userId:3,organizationId:recipient,action:"read"
    }),true);
    assert.equal(hasActiveAlertRecipientGrant(database,{
      alertId:100,userId:2,organizationId:owner,action:"read"
    }),false,"a same-role peer from the owning organization receives no direct-user grant");

    const organizationGrant=createAlertRecipientGrant(database,{
      alertId:100,ownerOrganizationId:owner,recipientType:"organization",
      recipientOrganizationId:recipient,action:"deliver",actorUserId:1
    });
    transitionAlertRecipientGrant(database,{grantId:organizationGrant,nextStatus:"active",actorUserId:1});
    assert.equal(hasActiveAlertRecipientGrant(database,{
      alertId:100,userId:3,organizationId:recipient,action:"deliver"
    }),true);
    assert.equal(hasActiveAlertRecipientGrant(database,{
      alertId:100,userId:2,organizationId:owner,action:"deliver"
    }),false,"organization grants do not extend to a same-role user in the owning organization");
    const deliverPredicate=alertRecipientGrantSql("a","deliver");
    assert.equal(Boolean(database.prepare(`SELECT 1 FROM alerts a WHERE a.id=100 AND ${deliverPredicate}`).get(3,recipient)),true,
      "the SQL predicate used by list/export/outbox queries recognizes an active organization grant");
    assert.equal(Boolean(database.prepare(`SELECT 1 FROM alerts a WHERE a.id=100 AND ${deliverPredicate}`).get(2,owner)),false,
      "the SQL predicate denies a same-role user from the owning organization");
    assert.equal(Boolean(database.prepare(`SELECT 1 FROM alerts a WHERE a.id=100 AND ${deliverPredicate}`).get(2,recipient)),false,
      "the SQL predicate denies a user without active membership in the recipient organization");

    const groupGrant=createAlertRecipientGrant(database,{
      alertId:100,ownerOrganizationId:owner,recipientType:"group",
      recipientOrganizationId:recipient,recipientGroupId:group,action:"read",actorUserId:1
    });
    transitionAlertRecipientGrant(database,{grantId:groupGrant,nextStatus:"active",actorUserId:1});
    assert.equal(hasActiveAlertRecipientGrant(database,{
      alertId:100,userId:3,organizationId:recipient,action:"read"
    }),true);
    assert.equal(hasActiveAlertRecipientGrant(database,{
      alertId:100,userId:2,organizationId:recipient,action:"read"
    }),false,"group grants do not extend to a same-role user in the owning organization");
    const readPredicate=alertRecipientGrantSql("a","read");
    assert.equal(Boolean(database.prepare(`SELECT 1 FROM alerts a WHERE a.id=100 AND ${readPredicate}`).get(3,recipient)),true,
      "the correlated read predicate recognizes active group membership");

    transitionAlertRecipientGrant(database,{grantId:direct,nextStatus:"revoked",actorUserId:1});
    assert.equal(database.prepare("SELECT status FROM alert_recipient_grants WHERE id=?").get(direct).status,"revoked");
    assert.throws(()=>transitionAlertRecipientGrant(database,{
      grantId:direct,nextStatus:"active",actorUserId:1
    }),/not permitted/);
    assert.throws(()=>createAlertRecipientGrant(database,{
      alertId:100,ownerOrganizationId:recipient,recipientType:"user",recipientUserId:3,
      recipientOrganizationId:recipient,action:"read",actorUserId:1
    }),/valid recipient|FOREIGN KEY|CHECK constraint/);
    assert.throws(()=>createAlertRecipientGrant(database,{
      alertId:100,ownerOrganizationId:owner,recipientType:"user",recipientUserId:3,
      recipientOrganizationId:owner,action:"read",actorUserId:1
    }),/valid recipient|FOREIGN KEY|CHECK constraint/);
    const events=database.prepare("SELECT event_type FROM alert_recipient_grant_events WHERE grant_id=? ORDER BY id").all(direct);
    assert.deepEqual(events.map(row=>row.event_type),["grant_created","grant_activated","grant_revoked"]);
    assert.throws(()=>database.prepare(
      "UPDATE alert_recipient_grant_events SET to_status='active' WHERE grant_id=?"
    ).run(direct),/immutable/);
  } finally {
    database.close();
  }
});

test("grant expiry is immediate at authorization time and terminal after expiry sweep",async()=>{
  const database=fixture();
  try{
    const owner=createOrganization(database,{slug:"expiry-owner",name:"Expiry Owner",actorUserId:1});
    const recipient=createOrganization(database,{slug:"expiry-recipient",name:"Expiry Recipient",actorUserId:1});
    const membership=requestOrganizationMembership(database,{organizationId:recipient,userId:3,actorUserId:1});
    transitionOrganizationMembership(database,{membershipId:membership,nextStatus:"active",actorUserId:1});
    database.prepare("INSERT INTO alerts(id) VALUES(101)").run();
    assignAlertOrganizationOwner(database,{alertId:101,organizationId:owner,actorUserId:1});
    const expiresAt=new Date(Date.now()+1500);
    const grant=createAlertRecipientGrant(database,{
      alertId:101,ownerOrganizationId:owner,recipientType:"user",recipientUserId:3,
      recipientOrganizationId:recipient,action:"read",actorUserId:1,
      startsAt:new Date(Date.now()-60*60*1000).toISOString(),expiresAt:expiresAt.toISOString()
    });
    transitionAlertRecipientGrant(database,{grantId:grant,nextStatus:"active",actorUserId:1});
    assert.equal(hasActiveAlertRecipientGrant(database,{
      alertId:101,userId:3,organizationId:recipient,at:new Date(Date.now()+500)
    }),true);
    assert.equal(hasActiveAlertRecipientGrant(database,{
      alertId:101,userId:3,organizationId:recipient,at:expiresAt
    }),false);
    await new Promise(resolve=>setTimeout(resolve,1600));
    assert.equal(expireAlertRecipientGrants(database,{at:expiresAt}),1);
    assert.equal(database.prepare("SELECT status FROM alert_recipient_grants WHERE id=?").get(grant).status,"expired");
  }finally{database.close();}
});


test("future-start recipient grants remain non-authorizing until their effective window",()=>{
  const database=fixture();
  try{
    const owner=createOrganization(database,{slug:"future-grant-owner",name:"Future Grant Owner",actorUserId:1});
    const recipient=createOrganization(database,{slug:"future-grant-recipient",name:"Future Grant Recipient",actorUserId:1});
    const membership=requestOrganizationMembership(database,{organizationId:recipient,userId:3,actorUserId:1});
    transitionOrganizationMembership(database,{membershipId:membership,nextStatus:"active",actorUserId:1});
    database.prepare("INSERT INTO alerts(id) VALUES(102)").run();
    assignAlertOrganizationOwner(database,{alertId:102,organizationId:owner,actorUserId:1});
    const startsAt=new Date(Date.now()+60_000).toISOString();
    const expiresAt=new Date(Date.now()+120_000).toISOString();
    const grant=createAlertRecipientGrant(database,{
      alertId:102,ownerOrganizationId:owner,recipientType:"user",recipientUserId:3,
      recipientOrganizationId:recipient,action:"read",actorUserId:1,startsAt,expiresAt
    });
    assert.equal(hasActiveAlertRecipientGrant(database,{
      alertId:102,userId:3,organizationId:recipient
    }),false,"pending future grant must not authorize");
    assert.throws(()=>transitionAlertRecipientGrant(database,{
      grantId:grant,nextStatus:"active",actorUserId:1
    }),/validity window/i,"a future grant cannot be activated before its start");
  }finally{database.close();}
});
