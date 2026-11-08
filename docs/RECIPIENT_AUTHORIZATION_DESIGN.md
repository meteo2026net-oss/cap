# Recipient Authorization Design — Proposal Only

Status: **not approved, not implemented, and not enabled**. The source/schema gap findings and detailed multi-organization IDOR test plan are in [RECIPIENT_AUTHORIZATION_GAP_AUDIT.md](RECIPIENT_AUTHORIZATION_GAP_AUDIT.md).

The institutional decisions required before schema work are tracked in [RECIPIENT_AUTHORIZATION_POLICY_DECISIONS.md](RECIPIENT_AUTHORIZATION_POLICY_DECISIONS.md). The agreed technical sequence and phase gates are recorded there. This document converts the current Public-only containment into an implementation plan. It deliberately does not infer institutional organizations, recipient groups, identity providers, geographic jurisdiction, or the meaning of CAP `addresses`. An institution must approve those semantics before schema or enforcement code is introduced.

## 1. Security objective

Every authenticated read or action involving an alert must be authorized against the current user's verified identity and an explicit grant. A role such as `reviewer`, `approver`, or `admin` grants workflow capability; it must not silently grant access to every institution's Restricted or Private content.

The default decision is deny:
- Public: governed by the institution's public-feed policy and the existing published/status/time filters.
- Restricted: deny unless a valid, current, explicit grant matches the authenticated principal and the institution-approved grant semantics.
- Private: deny unless a valid, current, explicit grant matches the authenticated principal. Raw CAP address text is never itself proof of identity or authorization.

## 2. Identity prerequisites

Before implementation, the institution must select and document:
1. The authoritative identity source (for example, institution-managed accounts or a trusted identity provider).
2. How a user is linked to one or more organizations, agencies, or operational units.
3. Whether memberships are manually approved, synchronized, or provisioned from a trusted directory.
4. How a user identity is verified when CAP Private recipient addresses are used.
5. How disabled users, departed staff, temporary staff, service accounts, and emergency operators are handled.
6. Whether one user may belong to multiple organizations and how conflicting grants are resolved.

Do not derive organization membership from email suffixes, usernames, self-declared profile fields, CAP sender strings, or unverified `addresses`.

## 3. Candidate normalized data model

The following is a conceptual starting point, not a migration specification. Names, foreign keys, retention, and cardinality require institutional approval.

| Concept | Candidate attributes | Purpose |
|---|---|---|
| Organizations | id, external_key, name, active | Stable institutional boundary |
| User memberships | user_id, organization_id, status, verified_by, verified_at, valid_from, valid_until | Verified identity-to-organization relationship |
| Recipient groups | id, organization_id, name, active | Operational groups such as duty desks |
| Group memberships | group_id, user_id or organization_id, status, validity | Explicit group membership |
| Alert grants | alert_id, grantee_type, grantee_id, permission, valid_from, valid_until, granted_by, revoked_at, reason | Explicit per-alert authorization |
| Grant audit | grant_id, action, actor_id, timestamp, reason, before/after | Traceable grant and revocation lifecycle |

Candidate `grantee_type` values could include user, organization, and recipient group. The institution must decide whether each type is allowed for Restricted and Private separately. Avoid storing arbitrary email strings as a grant principal; resolve verified identities to stable principal IDs.

Use database foreign keys, uniqueness constraints, validity checks, indexes for alert/principal/expiry lookups, and transactional grant/revoke audit writes. A grant should never be inferred or created as a side effect of merely writing a CAP message.

## 4. Authorization decision contract

Implement one central server-side policy function only after policy approval. It should accept the authenticated user, alert row, requested action, and a consistent database snapshot; it must return an explicit allow/deny result and a reason code for internal audit.

Illustrative policy, not current behavior:

- Deny inactive users, stale sessions, unverified/expired memberships, and disabled organizations/groups.
- Allow Public reads only according to the approved public-feed rules.
- For Restricted, require an active matching grant and the required active membership chain.
- For Private, require the institution-approved explicit principal match; do not parse a free-text CAP address and assume it identifies the caller.
- For review/edit/approve/publish actions, require both the relevant workflow role and scope authorization. Scope access alone does not grant workflow permission.
- Re-check authorization inside the transaction for state-changing actions to avoid time-of-check/time-of-use gaps.
- Apply revocations immediately to subsequent requests. Define behavior for in-flight requests and queued deliveries explicitly.
- Never allow an admin role to bypass scope checks by default. If emergency break-glass access is approved, make it separately permissioned, time-limited, reasoned, notified, and audited.

## 5. Role and recipient boundary

Recipient grants and workflow roles must remain independent authorization dimensions:

- A role grants an action capability (for example, draft authoring, review, approval, publication, or delivery operations); it does not grant access to every alert in that scope.
- A recipient grant grants access to a particular alert or approved recipient set; it does not grant permission to create, review, approve, publish, or administer accounts.
- Every request involving a non-Public alert must pass both checks: the user's current workflow-role permission and the alert's current recipient-scope grant.
- A Viewer with a valid recipient grant remains read-only. A Forecaster with a grant may still edit only drafts they own unless a separately approved administrative exception applies.
- A Reviewer or Approver without a matching grant must not see the alert, its existence, identifiers, review history, or related audit metadata.
- A Publisher must have both the Publisher workflow permission and the required scope grant before publication or queue operations. Queue membership must not be treated as recipient authorization.
- Admin must not bypass scope checks by default. Any break-glass exception must be separately approved, time-limited, justified, independently reviewed, and audited.
- The current Reviewer/Approver route permissions overlap. The institution must decide whether review and approval are separate authorities, define the handoff/quorum, and ensure the same person cannot satisfy both stages where policy requires independent actors. See [ROLE_AUTHORIZATION_AUDIT.md](ROLE_AUTHORIZATION_AUDIT.md).

This boundary is important: adding recipient grants must not accidentally widen role permissions, and adding a workflow role must not implicitly widen recipient visibility.

## 6. Mandatory enforcement inventory

The same policy must protect every path that can disclose or act on alert-linked data:

- Alert collection, detail, CAP XML, JSON, GeoJSON, search, pagination, and CSV exports.
- Statistics, dashboards, operational metrics, counts, and aggregates where the result could reveal non-public activity.
- Review queue, review history, notes, versions, timeline, and relation/lineage traversal.
- Create, derive, edit, submit, return, approve, publish, cancel, and any future workflow transitions.
- Alert-linked audit history and exports; avoid leaking alert IDs, identifiers, sender, addresses, or hidden metadata through audit filters.
- Delivery outbox list/count/detail, claim, receipt, retry, stale recovery, and background retry/recovery jobs.
- Webhook inbox review and any future adapter or subscriber fan-out.
- Cached responses, exports, downloadable resources, and error messages.

For multi-alert endpoints, filter at the SQL query boundary before pagination, counts, ordering, export generation, or aggregation. Do not fetch a broad result set and filter only in application memory. For detail endpoints, consistently conceal unauthorized records (for example, 404) where the approved API contract requires non-disclosure.

## 7. Required regression matrix

Use at least two organizations, three users, two recipient groups, and multiple alerts. Include Public, Restricted, and Private fixtures. Test:

1. Correct user/group/organization grant allows the approved action.
2. Same-role user in another organization is denied.
3. User with no membership is denied.
4. Expired, revoked, disabled, and not-yet-valid grants are denied.
5. Disabled organization/group and deactivated user are denied.
6. A reviewer role without a scope grant cannot read or review another organization's alert.
7. A scope grant without the required workflow role cannot approve or publish.
8. Reviewer and Approver separation follows the approved workflow policy; a reviewer-only identity cannot approve when approval is reserved for a distinct approver, and one identity cannot satisfy both stages where dual control is required.
9. Private address text that does not resolve to a verified principal grants no access.
10. Collection pagination, total counts, CSV, stats, GeoJSON, XML, relations, audit, and metrics do not leak denied records.
11. Revocation blocks subsequent detail, list, export, workflow, and delivery access.
12. Concurrent revoke/read and grant/revoke races have deterministic, documented outcomes.
13. ID guessing, cross-tenant relations, duplicate identifiers, and alternate endpoint paths do not bypass policy.
14. Background jobs do not deliver after a grant expires or is revoked, according to the institution-approved queue policy.
15. All grant creation, change, expiry, and revocation events are attributable and tamper-evident.

Negative tests must assert both the response and the absence of side effects or leaked markers. Do not weaken existing CAP structural validation to implement authorization.

## 8. Operational controls

- Separate grant administration from ordinary alert authoring and publishing.
- Require MFA for privileged and recipient-administration roles as defined by policy.
- Decide whether grant creation/revocation requires dual control.
- Provide periodic access recertification and reports of orphaned/expired memberships and grants.
- Alert on repeated denied cross-organization access and privileged grant changes.
- Define break-glass procedures, maximum duration, review deadlines, and post-event notification.
- Keep external delivery adapters disabled until recipient selection and authorization are independently verified end-to-end.

## 9. Approval gates

Implementation must not begin until the institution signs off on:
- Identity authority and verification process.
- Organization and recipient-group hierarchy.
- Restricted and Private grant semantics.
- Whether CAP addresses are used, and the verified mapping process if so.
- Role matrix and separation of duties.
- Grant/revoke approval, expiry, emergency access, and audit retention.
- Cache, export, background delivery, and revocation behavior.
- Acceptance criteria and responsible owners for the regression matrix.

Until these decisions are approved and implemented, retain the existing Public-only API boundary. Do not create default grants, seed sample grants in production, or enable Restricted/Private workflows.


## Phase 1 implementation snapshot — provisional, not a policy approval

The current PR branch now contains the first organization/membership implementation slice:

- `src/recipient-auth.js` installs the organization, membership, and immutable membership-event tables and provides transaction-bound creation, transition, expiry, and current-membership checks.
- `src/db.js` installs the schema idempotently after the base user table exists. Existing users receive no automatic organization membership.
- `src/server.js` exposes administrator-only organization and membership management endpoints. This is a temporary conservative operator boundary, not a final delegated-administration model.
- `tests/recipient-auth.test.js` covers membership isolation for same-role users, lifecycle transitions, immutable event history, and expiry.
- `tests/recipient-auth.integration.test.js` exercises the API with two forecasters sharing the same workflow role but assigned to separate organizations.

Provisional behavior:
- A user may have memberships in multiple organizations, but each organization/user membership period is an explicit record.
- Only active platform administrators may create organizations, request memberships, activate, suspend, or revoke them.
- Memberships begin pending; activation records the approving administrator.
- Revoked and expired records are terminal. Rejoining requires a new membership record.
- Authorization checks require active account, active organization, active membership, and an effective UTC time window.
- The expiry sweep is a controlled operation; clients cannot directly set a membership to expired.

Important boundary: this phase does **not** yet attach alerts to owning organizations, create recipient groups or grants, or authorize Restricted/Private reads. It does not establish tenant isolation for alert data by itself. Restricted/Private remain blocked, Public-only API and delivery filters remain in force, and external adapters remain disabled. The same-role cross-organization alert IDOR acceptance gate is not complete until the grant and alert-owner phases are implemented.


### Phase 2 implementation snapshot — organization-scoped recipient groups

The branch now also includes:
- `recipient_groups`, with group identity scoped by organization and a unique group slug per organization.
- `recipient_group_memberships`, bound by composite foreign keys to both the owning group and one specific organization-membership period. A group cannot contain a user through a different organization's membership.
- Group membership lifecycle and immutable event history, with active-administrator mutation guards, terminal revocation/expiry, and request-time checks of the parent organization membership.
- Administrator-only group and group-membership endpoints.
- Unit and API integration coverage for identical group slugs in separate organizations, cross-organization membership substitution denial, and parent membership revocation.

The group layer is still not an alert authorization policy. No alert grants or owner-organization links are active yet; the Public-only containment remains unchanged.
