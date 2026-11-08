#!/usr/bin/env node
/**
 * Bootstrap two isolated acceptance tenants (accept-org-a / accept-org-b).
 *
 * Prerequisites: server running (npm start), admin credentials.
 * Does NOT enable external delivery adapters or CAP_WEBHOOK_INGRESS.
 * Does NOT close Gate 8.
 *
 * Usage:
 *   ACCEPT_BASE_URL=http://127.0.0.1:8095 \
 *   ACCEPT_ADMIN_USER=admin \
 *   ACCEPT_ADMIN_PASSWORD='...' \
 *   node scripts/bootstrap-acceptance-tenants.mjs
 */
import { randomBytes } from "node:crypto";

const base = (process.env.ACCEPT_BASE_URL || "http://127.0.0.1:8095").replace(/\/$/, "");
const adminUser = process.env.ACCEPT_ADMIN_USER || "admin";
const adminPassword = process.env.ACCEPT_ADMIN_PASSWORD || "";

if (!adminPassword || adminPassword.length < 8) {
  console.error("Set ACCEPT_ADMIN_PASSWORD to the administrator password.");
  process.exit(1);
}

function password() {
  return randomBytes(18).toString("base64url") + "Aa1!";
}

async function req(path, { method = "GET", token, body } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

function assertOk(label, result, ok = (s) => s >= 200 && s < 300) {
  if (!ok(result.status)) {
    console.error(`FAIL ${label}: HTTP ${result.status}`, result.data);
    process.exit(1);
  }
}

const usersSpec = [
  { username: "acc_forecaster_a", role: "forecaster", org: "a" },
  { username: "acc_reviewer_a", role: "reviewer", org: "a" },
  { username: "acc_publisher_a", role: "publisher", org: "a" },
  { username: "acc_approver_a", role: "approver", org: "a" },
  { username: "acc_viewer_a", role: "viewer", org: "a" },
  { username: "acc_forecaster_b", role: "forecaster", org: "b" },
  { username: "acc_reviewer_b", role: "reviewer", org: "b" },
];

const login = await req("/api/auth/login", {
  method: "POST",
  body: { username: adminUser, password: adminPassword },
});
if (login.status !== 200 || !login.data?.token) {
  if (login.data?.mfa_required) {
    console.error("Admin requires MFA. Complete MFA login and pass a session token via a future extension; aborting.");
  } else {
    console.error("Admin login failed:", login.status, login.data);
  }
  process.exit(1);
}
const token = login.data.token;

const health = await req("/api/health");
assertOk("health", health);
if (health.data?.external_adapters_enabled === true) {
  console.error("Refusing to bootstrap: external_adapters_enabled is true.");
  process.exit(1);
}

async function ensureOrg(slug, name) {
  const list = await req("/api/organizations", { token });
  assertOk("list orgs", list);
  const existing = (list.data?.organizations || []).find((o) => o.slug === slug);
  if (existing) return existing;
  const created = await req("/api/organizations", {
    method: "POST",
    token,
    body: { slug, name },
  });
  assertOk(`create org ${slug}`, created, (s) => s === 201 || s === 409);
  if (created.status === 201) return created.data;
  const again = await req("/api/organizations", { token });
  return (again.data?.organizations || []).find((o) => o.slug === slug);
}

const orgA = await ensureOrg("accept-org-a", "Acceptance Org A");
const orgB = await ensureOrg("accept-org-b", "Acceptance Org B");
if (!orgA?.id || !orgB?.id) {
  console.error("Could not resolve organization ids", { orgA, orgB });
  process.exit(1);
}

const issued = [];
for (const spec of usersSpec) {
  const pwd = password();
  let userId;
  const created = await req("/api/users", {
    method: "POST",
    token,
    body: { username: spec.username, password: pwd, role: spec.role },
  });
  if (created.status === 201) {
    userId = created.data.id;
    issued.push({ username: spec.username, role: spec.role, password: pwd, org: spec.org });
  } else if (created.status === 409) {
    const all = await req("/api/users", { token });
    assertOk("list users", all);
    const u = (all.data?.users || []).find((row) => row.username === spec.username);
    if (!u) {
      console.error(`Username conflict but user not listed: ${spec.username}`);
      process.exit(1);
    }
    userId = u.id;
    issued.push({ username: spec.username, role: spec.role, password: "(existing-unchanged)", org: spec.org });
  } else {
    assertOk(`create user ${spec.username}`, created);
  }

  const orgId = spec.org === "a" ? orgA.id : orgB.id;
  const mem = await req(`/api/organizations/${orgId}/memberships`, {
    method: "POST",
    token,
    body: { user_id: userId },
  });
  if (mem.status === 201 || mem.status === 200) {
    const membershipId = mem.data?.id;
    if (membershipId) {
      const act = await req(`/api/organization-memberships/${membershipId}`, {
        method: "PATCH",
        token,
        body: { status: "active" },
      });
      assertOk(`activate membership ${spec.username}`, act);
    }
  } else if (mem.status === 409) {
    // already member — ok
  } else {
    assertOk(`membership ${spec.username}`, mem);
  }
}

async function ensureSource(org, key, label) {
  const list = await req(`/api/webhook-sources?organization_id=${org.id}`, { token });
  assertOk("list webhook sources", list);
  const existing = (list.data?.sources || []).find((s) => String(s.source_key).toLowerCase() === key.toLowerCase());
  if (existing) {
    return { id: existing.id, source_key: key, secret: "(existing-secret-not-retrievable)" };
  }
  const created = await req("/api/webhook-sources", {
    method: "POST",
    token,
    body: {
      organization_id: org.id,
      source_key: key,
      label,
    },
  });
  if (created.status === 409) {
    return { id: null, source_key: key, secret: "(conflict-existing)" };
  }
  if (created.status !== 201) {
    console.error("Webhook source create failed:", created.status, created.data);
    return null;
  }
  return {
    id: created.data?.id,
    source_key: created.data?.source_key || key,
    secret: created.data?.secret || "(missing-once-only-secret)",
  };
}

const sourceA = await ensureSource(orgA, "accept-source-a", "Acceptance Source A");
const sourceB = await ensureSource(orgB, "accept-source-b", "Acceptance Source B");

console.log(JSON.stringify({
  ok: true,
  note: "Acceptance tenant bootstrap only. Gate 8 remains Open. external_adapters must stay false.",
  base_url: base,
  organizations: {
    a: { id: orgA.id, slug: orgA.slug || "accept-org-a" },
    b: { id: orgB.id, slug: orgB.slug || "accept-org-b" },
  },
  users: issued,
  webhook_sources: { a: sourceA, b: sourceB },
  health: {
    external_adapters_enabled: health.data?.external_adapters_enabled,
  },
  next: [
    "Save issued passwords offline; new users must_change_password may be true",
    "Run pack scenarios in docs/ISOLATED_ACCEPTANCE_TEST_PACK.md",
    "Do not mark INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md Accepted from this script",
  ],
}, null, 2));
