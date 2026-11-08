# Account and Recipient Authorization Review

Review basis: source and regression tests at PR head `bb797ad2a14498df14fb7b7623643ba9bc7f7b8d` (2026-11-08). This is a code-level review of the current local SQLite application, not an institutional identity or authorization approval.

## Verified account controls

- Usernames are unique and constrained to 3–64 ASCII letters, digits, dot, underscore, or hyphen. Passwords supplied when creating accounts are 14–200 characters and bcrypt-hashed (cost 12).
- New accounts receive a forced password change. Auth middleware blocks application and operational endpoints until the temporary password is replaced; profile and password/MFA setup routes remain available.
- Login failures use a generic response and a dummy bcrypt comparison for unknown/inactive accounts. Login, MFA challenge/enrollment/confirmation/disable/recovery, password change, and administrator password reset have rate limits.
- Sessions are JWTs with an eight-hour lifetime and an account `token_version`. Password changes, administrator password resets, role changes, deactivation, MFA enable/disable, and recovery-code rotation invalidate earlier sessions.
- Administrator-assisted password reset is restricted to another active account, issues a random temporary password once with no-store headers, forces a password change, preserves an already-enabled MFA factor, consumes outstanding login challenges, and records an audit event. It does not provide verified self-service recovery or email delivery.
- Account creation, role changes, activation/deactivation, and password resets are admin-only and audited. Account creation and password reset use transactional audit writes. Last-active-admin protections prevent deactivating or demoting the final active administrator.
- TOTP secrets are encrypted; login challenges are short-lived and single-use; TOTP steps cannot be replayed; recovery codes are one-time and rotation invalidates the previous set.
- Role checks are enforced server-side. MFA can be required centrally through `MFA_REQUIRED_ROLES`; when a role is listed, protected routes are blocked until MFA is confirmed.

## Current role capabilities observed in route guards

| Role | Current application capabilities |
|---|---|
| `admin` | User lifecycle administration, retention, alert drafting and editing, review/approval, publishing, delivery operations, audit access, and operational metrics |
| `forecaster` | Create/derive/edit/submit alert drafts; read Public alerts |
| `reviewer` | Review queue, review notes/history, return and approve pending alerts; webhook inbox review |
| `approver` | Same route-level review/return/approve permissions as reviewer |
| `publisher` | Publish approved alerts, inspect/process internal delivery outbox, operational metrics |
| `viewer` | Read Public alerts and applicable public-facing authenticated views |

The application enforces separation of the alert creator from the reviewer/approver and the approving user from the publisher. These are useful two-person checks, but the administrator role intentionally spans multiple capabilities. Reviewer and approver currently have identical route-level permissions; the code does not enforce a distinct approval authority between those two role names.

## Recipient and organization authorization findings

- There is no organization, tenant, agency, group, jurisdiction, polygon assignment, or user-to-recipient grant table in the current schema.
- Role names are functional permissions, not proof that a person is an intended CAP recipient. No role receives implicit Restricted or Private access.
- CAP `restriction` and `addresses` fields are message metadata. They are not authenticated identity claims, access-control lists, or proof of recipient delivery.
- The current application exposes Public-scope records to authenticated application roles and uses a temporary fail-closed boundary for Restricted and Private records. Legacy non-Public records remain stored but inaccessible through the application API. New valid non-Public creation and promotion are blocked.
- Public alert access is not narrowed by organization or geography. This is acceptable only where the institution intends the Public feed to be globally visible.
- The inbound webhook inbox is a separate, global manual-triage queue for admin/reviewer roles. It is not a recipient grant mechanism and does not create or publish alerts.
- No external distribution adapter is enabled. Internal outbox permissions must not be mistaken for proof that a recipient received a warning.

## Open policy and engineering decisions

1. The institution must define authoritative identities and organizations, including who may create, review, approve, publish, administer, and receive each warning class.
2. The institution must decide whether reviewer and approver are distinct authorities, whether an administrator may act in multiple workflow roles, and whether role assignment itself requires dual control.
3. Before recipient-level authorization can be implemented, define the trusted source of user-to-organization membership and recipient groups, how membership changes are verified, and how geographic/temporal coverage is represented.
4. Define whether Restricted grants attach to a message, organization, recipient group, area, or a combination; define Private address matching semantics and whether addresses identify authenticated recipients.
5. Define grant/revoke lifecycle, expiry, emergency overrides, audit retention, break-glass review, and the treatment of existing messages when memberships or grants change.
6. Define whether public statistics, feeds, and search are globally visible or jurisdiction-filtered.
7. Configure `MFA_REQUIRED_ROLES` explicitly for the deployment. The default empty value does not require MFA for any role. Decide whether all privileged roles, including forecasters and reviewers, require MFA.
8. Complete a verified self-service account recovery design or document an approved manual identity-verification and temporary-password transfer process.
9. Establish institution-controlled role matrices, least-privilege review, and periodic access recertification.

## Reopening gate for Restricted and Private

Do not remove the Public-only boundary until an approved recipient model has been implemented with deny-by-default SQL/API enforcement across list, detail, XML, export, statistics, review, audit, versions, timeline, relations, mutations, delivery, metrics, and background operations. The implementation must audit grant/revoke changes, handle concurrent membership changes consistently, and pass multi-user/multi-organization IDOR tests for allowed, denied, revoked, expired, and cross-area access. Validate CAP XML conformance separately from application authorization. A passing XSD test does not establish recipient entitlement.

## Evidence and limitations

At the review basis above, the exact PR head passed CAP System Checks (211 Node tests, 0 failures; 10,000-message synthetic benchmark; official OASIS CAP 1.2 XSD suite, 8 tests, 0 failures; Windows backup/restore) and CodeQL. These results demonstrate automated regression coverage on that commit, not an external penetration test, institutional identity verification, recipient delivery, certification, or production readiness.


## Additional privileged-administration risk

The current administrator model is single-actor for account provisioning and recovery:
- An administrator can create a new `admin` account or promote another account to `admin`; there is no second-person approval workflow for privileged-role grants.
- An administrator can reset the password of any other active account, including another administrator. The generated temporary password is returned once to the requesting administrator. Although the target must change it and existing sessions are revoked, the administrator who receives that value could authenticate as the target account. This creates an account-impersonation and audit-attribution risk for privileged accounts.
- Self-reset and self-role-change are blocked, and the last active administrator cannot be demoted or deactivated, but these controls do not prevent one administrator from changing another administrator's credentials or role.

Before operational use, the institution should decide whether creation/promotion of administrators and resets of privileged accounts require dual authorization, out-of-band identity verification, notification to the target, a controlled password handoff, and explicit audit events. No policy was assumed or enforcement change made in this review.


## Endpoint-level role matrix observed in `src/server.js`

This matrix describes current route guards, not a recommendation or institutional approval.

| API capability | Admin | Forecaster | Reviewer | Approver | Publisher | Viewer |
|---|---:|---:|---:|---:|---:|---:|
| Read authenticated Public alert list/detail/XML, stats, CSV | Yes | Yes | Yes | Yes | Yes | Yes |
| Create, derive, edit, submit alert | Yes | Yes | No | No | No | No |
| Read review queue/history, versions, timeline; add review notes | Yes | No | Yes | Yes | No | No |
| Return or approve an alert | Yes | No | Yes | Yes | No | No |
| Publish an approved alert | Yes | No | No | No | Yes | No |
| Read/review inbound webhook inbox | Yes | No | Yes | No | No | No |
| Read/process internal delivery outbox and retries | Yes | No | No | No | Yes | No |
| Read operational health metrics | Yes | No | No | No | Yes | No |
| Read/export/verify audit history | Yes | No | Yes | Yes | No | No |
| List/create accounts; reset passwords; change roles/status | Yes | No | No | No | No | No |
| Apply operational retention | Yes | No | No | No | No | No |

Important observations:
- Reviewer and approver are identical for alert review/return/approval and audit routes; only reviewer (not approver) can review inbound webhook items.
- Admin is included in nearly every operational role guard, so the application does not enforce least privilege or separation of duties for administrators.
- Forecaster, reviewer, approver, publisher, and viewer all receive the same broad authenticated Public alert read capability; none receives a narrower organization or jurisdiction filter.
- Role authorization and scope authorization are separate concerns. Passing a route-role check does not imply a recipient entitlement, and this matrix does not grant Restricted/Private access.

## Account administration safeguards and remaining exposure
- Account creation and password reset write their audit events in the same immediate SQLite transaction as the account mutation. Role and activation changes also use immediate transactions and record old/new role or activation state.
- Last-active-admin checks run inside the immediate transaction, preventing concurrent demotion/deactivation from removing the final active administrator.
- Admin password reset is rate-limited to five requests per 15 minutes per limiter key and cannot target the requesting administrator. However, it can target another administrator and returns the generated temporary password to the requesting administrator. It preserves the target's existing enabled MFA factor but does not require dual authorization or notify the target through a verified independent channel.
- Account creation and role/status mutation routes rely on the admin role guard and the global API limiter; they do not have a separate operation-specific rate limiter. Review whether privileged account changes need an additional approval/notification control.
- The deployment example leaves `MFA_REQUIRED_ROLES` blank. The code therefore does not require MFA for any role unless the operator configures it. This is a deployment control, not a guaranteed secure default.


## Privileged-account hardening follow-up — 2026-11-08

Source review and regression coverage were extended on the current follow-up branch:

- Administrator-assisted password reset now refuses targets whose current role is admin. The reset transaction returns a privileged-target result before changing the password hash, token version, MFA enrollment state, or login challenges; the requester receives no temporary credential.
- The API integration test provisions a second administrator, attempts a peer-admin reset, verifies HTTP 403 and absence of a temporary password in the response, and confirms the target's original credential still authenticates.
- Account creation, role changes, and activation/deactivation now share an administrator-specific rate limiter (30 mutations per 15 minutes per authenticated administrator). The existing password-reset limiter remains separate.
- Self-role-change, self-password-reset, self-deactivation, last-active-admin protection, transactional audit writes, and session invalidation remain in place.

### Remaining privileged-account policy gap

This hardening closes the direct peer-admin credential handoff path; it does not implement dual control. A single administrator can still create another administrator or promote an existing account to admin, and can still reset non-admin accounts. The institution must decide whether privileged-role grants, demotions, account recovery, and sensitive non-admin resets require a second approver, verified out-of-band identity checks, target notification, or a supervised credential handoff. Until that policy and workflow are approved and implemented, administrator provisioning remains a single-actor trust boundary and must be treated as a governance risk.

The new rate limit is an abuse-control measure, not an approval quorum. No account has been promoted, demoted, activated, deactivated, or reset as part of this code change. No MFA deployment policy was changed; an empty MFA_REQUIRED_ROLES setting still means MFA is not mandatory by default.
