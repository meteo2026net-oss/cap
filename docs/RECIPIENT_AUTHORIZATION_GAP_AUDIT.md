# Recipient Authorization Gap Audit — CAP 1.2

Historical audit target: PR #4 head `1f7029b4487ddb929a0edb8083136a87bf91c165`. Current technical status is superseded by the addendum at the end of this document (reviewed against PR #4 head `955a713be17748e2622db5d87822750186f1a572`).
Review type: source/schema/test inspection. No recipient schema, membership data, grants, account records, or deployment settings were changed.

## 1. Executive conclusion

Status: Public-only containment remains the production default; recipient authorization mechanisms are implemented but gated pending institutional approval.

At the historical audit target, the repository did **not** implement a multi-organization recipient authorization model. The implementation has since evolved; consult the current-status addendum before relying on historical findings below.

- The `users` table has account identity and workflow role, but no organization or tenant membership relation.
- The `alerts` table has CAP `scope`, creator and approver identities, but no owning organization, tenant, or recipient-set relation.
- The schema has no organization, membership, recipient-group, group-membership, alert-grant, or grant-audit tables.
- No central authorization decision resolves a principal's active membership and grant for an alert/action.
- CAP `restriction` and `addresses` are stored message fields; they are not validated identity links and cannot authorize a user.
- The API intentionally denies Restricted/Private collection access and creation/promotion. Existing legacy non-Public rows are concealed from API detail and excluded from collection, review, audit, relation, public-feed, and delivery surfaces.

Therefore, multi-organization IDOR resistance is **not yet implementable or certifiable**: the product has no tenant boundary to enforce. Current tests prove fail-closed handling of non-Public scopes and several ID-alias/path cases, not isolation between two actual organizations with active/revoked grants.

## 2. Current evidence by authorization layer

| Layer | Current implementation | Audit result |
|---|---|---|
| Account identity | `users.id`, username, role, active status, session token version, MFA state | Authenticated principal exists; no organization membership |
| Organization | No organization table or organization key on users/alerts | Missing |
| Membership | No user-organization membership lifecycle | Missing |
| Recipient groups | No group or group membership tables | Missing |
| Alert recipient grants | No user/org/group-to-alert grant relation | Missing |
| Grant administration | No grant create/approve/revoke/expire routes | Missing |
| Central policy | Role middleware plus Public-only scope guard | No membership/grant policy function |
| Revocation | Account deactivation/session version controls exist; recipient grant revocation does not | Recipient revocation semantics missing |
| Auditability | General append-only audit chain exists, but no grant lifecycle events | Must be extended for grant decisions |
| Delivery | Outbox rows are Public-only; global maintenance fails closed when legacy non-Public rows exist | No recipient-aware selection or revoke-before-delivery check |

## 3. Existing protections that are useful but limited

The current source and integration tests establish these controls:

1. Collection reads, counts, CSV exports, review queue, statistics, public feeds, and delivery outbox are filtered to Public.
2. Restricted/Private query filters are rejected rather than treated as access grants.
3. Legacy Restricted/Private detail, XML, relations, review history, versions, timeline, and workflow mutations return concealed 404 responses.
4. Numeric ID aliases with leading zeroes do not bypass the non-Public concealment guard.
5. Relationship traversal only follows Public parent/child candidates; a Public root does not expose a non-Public related child.
6. Audit listing/export and delivery outbox/claim/retry/receipt paths exclude non-Public alert-linked rows.
7. Background retry and stale-lease maintenance stop globally when legacy non-Public outbox rows exist.
8. A Public alert cannot be promoted to Restricted/Private through the API.

These tests are important baseline defenses. They do not establish organization A versus organization B isolation, membership validation, grant precedence, grant expiry, or revocation behavior because those entities do not exist.

## 4. Membership lifecycle requirements before schema implementation

The institution must select an authoritative identity source and define the lifecycle before adding migrations.

### Membership states

At minimum, model explicit states such as `pending`, `active`, `suspended`, `revoked`, and `expired`, with:
- stable user and organization foreign keys;
- who verified/approved the membership and when;
- effective-from and effective-until timestamps;
- reason and source/provisioning reference;
- unique constraints preventing ambiguous duplicate active memberships;
- transactional audit events for every state transition.

A user may belong to multiple organizations only if policy explicitly allows it. Never infer membership from username, email domain, CAP sender, CAP `addresses`, or self-declared profile data.

### Membership changes

- Pending, suspended, revoked, expired, or not-yet-effective membership must deny access.
- Deactivated users and disabled organizations must deny access even if a grant row remains active.
- Re-activation must not silently resurrect expired/revoked grants.
- Organization transfer must not copy grants implicitly.
- Session and cache behavior after membership removal must be defined; subsequent requests must re-check current authorization, not trust stale JWT role claims.

## 5. Grant lifecycle requirements

A grant must identify a stable principal or approved group, an alert or approved recipient set, allowed actions, validity window, issuer, and audit reason.

Required semantics:
- Deny by default; no default grants on migration or account creation.
- A grant is usable only if the user is active, membership is currently active, organization/group is active, and the grant is active and in its validity window.
- Scope authorization and workflow-role authorization are separate conjunctive checks. A grant never supplies a role; a role never supplies a recipient grant.
- Grant creation must validate that the grantor is authorized to administer that recipient boundary.
- Define whether grant creation/revocation needs dual control; never assume the Admin role should bypass scope checks.
- Expiry must be evaluated at request time, not only by a cleanup job.
- Revocation must block subsequent reads, exports, workflow actions, and queued delivery decisions.
- Record grant creation, approval, change, expiry, revocation, denied use, and break-glass use with attributable, tamper-evident audit events.
- A break-glass path, if approved, must be separate, short-lived, reasoned, independently reviewed, and audited.

## 6. Required multi-organization IDOR regression suite

Do not label the model ready until the suite below runs against the real authorization implementation. Fixtures must use at least:
- Organization A and Organization B;
- User A and User B, both with the same workflow role;
- a user belonging to both organizations only if multi-membership is approved;
- at least one active, suspended, expired, and revoked membership;
- recipient groups in both organizations;
- separate Restricted and Private alerts owned by each organization;
- active, expired, revoked, and not-yet-valid grants.

### Cross-organization isolation

1. User A with an active grant to Alert A can read only the allowed Alert A fields.
2. User B with the same role but no membership/grant to Alert A is denied.
3. User B cannot discover Alert A through list, search, pagination, total counts, statistics, CSV, GeoJSON, XML, relations, review queue, audit, or metrics.
4. Guessing Alert A's numeric ID, padded ID, CAP identifier, sender/identifier pair, group ID, grant ID, or export cursor does not disclose existence or metadata.
5. User A cannot change ownership, organization ID, grantee, or grant fields through mass assignment or alternate routes.
6. A grant to Organization A does not authorize members of Organization B, even when usernames/emails or roles match.
7. A grant to a group authorizes only current active members of that exact group and organization; no cross-organization group substitution.

### Membership and grant lifecycle

8. Pending, suspended, expired, revoked, and not-yet-valid memberships deny access.
9. Disabled organization/group, deactivated user, and expired/revoked grants deny access.
10. Removing a user from a group immediately removes group-derived access on the next request.
11. Revoking a direct grant immediately denies detail, list, export, XML, relations, review, workflow, and delivery access.
12. Re-enabling an account or membership does not revive a separately revoked grant.
13. Duplicate grants, conflicting direct/group grants, and overlapping validity periods have deterministic policy-defined outcomes.
14. A grant without the required workflow role cannot perform the action; a workflow role without a matching grant cannot access the alert.

### Mutation and race / TOCTOU cases

15. Concurrent revoke/read and revoke/write operations have a documented linearization point; no write succeeds after revocation commits.
16. Grant expiry during a long-running request and before a background job's final action is re-checked at the protected transaction boundary.
17. A user cannot approve their own created alert or satisfy both review and approval stages where dual control is required.
18. A user cannot publish an alert they approved when policy requires separate publisher identity.
19. Changing an alert's organization, recipient group, or scope cannot carry old grants into the new boundary.
20. All denied mutations leave no state change, audit side effect beyond the intended denial record, or queued delivery.

### Delivery and indirect disclosure

21. Outbox selection is filtered by the current recipient grant before pagination/counts/claim.
22. A revoked/expired grant prevents a not-yet-started queued delivery from being claimed or sent.
23. A receipt or retry for a delivery not visible to the caller returns a concealed response and has no side effect.
24. Webhook inbox, callback, retry, stale lease recovery, and dead-letter maintenance cannot bypass the same policy.
25. Cache keys and export artifacts are principal/tenant/grant-aware; revocation invalidates or bypasses cached authorization results.

Every negative test must assert status, response-body marker absence, and unchanged database state. Test both same-role cross-organization users and different-role users. Run tests with real SQLite constraints and transaction boundaries; avoid mocked policy functions as the only evidence.

## 7. Implementation order after policy approval

1. Record signed decisions for identity authority, organization hierarchy, multi-membership, Restricted/Private semantics, recipient group types, and role separation.
2. Add normalized organization, membership, group, grant, and grant-audit migrations with foreign keys, uniqueness constraints, validity checks, and indexes.
3. Add one central policy service with deny-by-default decisions and explicit reason codes; keep scope and role checks independent.
4. Apply policy to every disclosure/action path listed in the design inventory, with SQL filtering before pagination, aggregation, and export.
5. Re-check authorization transactionally for mutations and immediately before background delivery actions.
6. Add the full IDOR, cross-tenant, lifecycle, race, export, cache, and delivery regression suite.
7. Complete independent security review and institution acceptance before enabling any non-Public access.

## 8. Current release gate

- Restricted/Private creation, listing, reading, promotion, and delivery remain blocked.
- `external_adapters_enabled: false` remains unchanged.
- No membership, group, or recipient grants are seeded or inferred.
- Do not merge or claim recipient authorization readiness on the basis of Public-only scope tests.


## 9. Route and background-surface inventory

This inventory was checked against `src/server.js`, `src/delivery.js`, `src/delivery-worker.js`, `src/retention.js`, and `src/audit.js` at the audit target. "Public-only" below means the current fail-closed scope rule, not a future organization grant.

| Surface | Current boundary | Required recipient-model treatment |
|---|---|---|
| `GET /api/alerts`, `/stats`, `/export.csv` | SQL constrained to Public before count/page/export | Add organization + grant predicate in SQL before COUNT, LIMIT/OFFSET, and export |
| `GET /api/alerts/:id`, `/cap.xml`, `/relations` | Middleware conceals existing non-Public rows; relation traversal filters related rows to Public | Resolve the root grant and independently authorize each related record; do not inherit access from a visible root |
| Review queue/history/notes/versions/timeline | Workflow roles plus Public-only filtering or concealment | Require both workflow capability and organization/alert grant; protect audit/version joins and counts |
| Alert create/derive/edit/submit/return/approve/publish | Role/workflow/ownership rules; non-Public create/promotion blocked | Bind alert to immutable owning organization; validate grant and workflow capability on each transition |
| `GET /api/delivery/outbox` and per-ID claim/receipt/retry | Publisher/admin role; Public-only SQL and ID concealment | Filter by authorized recipient and current grant at selection and mutation transaction boundary |
| Delivery retry/recovery API and `delivery-worker.js` | Global maintenance pauses if any non-Public outbox row exists; worker itself only processes Public | Replace global pause only after each job is tenant/grant-scoped; re-check grant immediately before claim/dispatch |
| `GET/PATCH /api/webhooks/inbox` | Global admin/reviewer inbox, cursor by global ID; payload not tied to a tenant | Bind ingress identity/source to an organization; scope inbox list, cursor, review and audit by that organization |
| `POST /api/webhooks/inbound` | Signature/replay protection and global inbox insert; no authenticated user or organization mapping | Verify configured source-to-organization mapping and persist immutable tenant attribution before accepting |
| `GET /api/audit`, `export.csv` | Alert-linked entries restricted to Public; alert-less events are globally visible except retention marker | Define organization attribution for grant/membership/admin events; prevent one tenant from reading another tenant's audit details; preserve global chain verification separately |
| `GET /api/audit/verify` | Verifies the global hash chain; does not return event rows | Decide whether integrity status is global operational metadata or a privileged system-only function; never treat it as tenant event access |
| `GET /api/health/metrics` | Admin/publisher global operational aggregates, currently Public-only alert counts | Decide whether aggregate metrics may be global; if not, scope every aggregate before grouping |
| `POST /api/ops/retention/apply` | Global admin operation pruning terminal delivery and reviewed webhook rows | Define tenant-aware retention policy and ensure deletion predicates cannot cross a tenant's legal hold/retention boundary |
| `GET /api/users`, user create/role/status/reset | Global Admin account administration | Separate platform administration from organization administration; org admins must only manage users in their own organization |
| Public feeds and health endpoints | Public feeds explicitly query published Public alerts; health reports static capability state | Keep feeds strictly Public; never reveal organization membership or grant metadata |

### Specific high-risk gaps surfaced by route review

1. **Webhook tenant attribution is absent.** Inbound webhook messages are persisted in a global inbox. The inbound signature/replay guard proves message authenticity relative to a configured secret, not which organization owns the source or which users may review its payload. A future multi-organization deployment needs per-source organization binding, separate secrets/keys where appropriate, and tenant-scoped inbox queries and review mutations.
2. **Global audit events need an explicit policy.** The current audit list/export intentionally includes alert-less events (except the retention marker). Once membership and grant lifecycle events are added, those events can expose usernames, organization IDs, administrative actions, or grant reasons. Add organization attribution and explicit platform-global event classes; do not infer tenant visibility from `alert_id IS NULL`.
3. **Retention is global today.** Delivery and webhook retention delete across the whole database. Before organizations have different legal/operational retention policies or holds, retention needs tenant-aware eligibility and auditable policy selection.
4. **Operational aggregates are privileged but global.** Metrics are restricted to Admin/Publisher and currently count Public records. If metrics later include non-Public data, scope before aggregation or explicitly approve a platform-global aggregate with disclosure review.
5. **The current worker has no principal context.** It is safe only because it performs Public-only maintenance and pauses globally when any non-Public outbox row exists. It cannot safely become a recipient-aware dispatcher by adding a role or group check in the HTTP API alone; background jobs must evaluate persisted source, tenant, membership, grant expiry, and revocation state themselves.

No code or schema changes are implied by this inventory. These are policy and implementation gates, not permission to activate non-Public access.


## 10. Implementation checkpoint — 2026-11-08

The follow-up branch now contains organization, membership, recipient-group, alert-owner, and recipient-grant schema/API primitives. These are staged administrative controls, not end-to-end tenant authorization:

- Organization, membership, group, and grant management endpoints remain platform-admin-only.
- Alert list/detail, CAP XML, CSV export, relations, review/version/timeline, audit-linked alert views, delivery outbox, and worker maintenance still rely on the temporary Public-only boundary. The grant predicate is **not** wired into those disclosure/action paths.
- Public alerts remain globally readable by authenticated roles under the current Public-feed policy. This is intentional and must not be described as an organization-level IDOR fix.
- A same-role cross-organization API regression fixture now exercises Forecaster, Reviewer, and Publisher identities in separate organizations. Its negative assertions cover direct IDs and Public-only concealment of legacy non-Public rows; positive Public visibility is asserted as the current global policy. This is a containment test, not proof that authorized Restricted/Private reads work.
- Grant unit tests cover direct-user, organization, and group predicates, including same-role users in different organizations. The API integration test rejects a direct grant that misrepresents a user from Organization A as a member of Organization B.

### Surfaces that remain explicitly unscoped

1. **Webhook ingress/inbox:** inbound signatures authenticate the configured shared secret, not an organization. Inbox rows and reviewer access remain global; source-to-organization attribution and tenant-scoped cursors/review are not implemented. Do not claim webhook IDOR isolation.
2. **Audit events without an alert:** the hash chain and audit list remain global operational records. Membership/group/grant events can contain organization and account details; an explicit tenant/platform event visibility policy and schema attribution are still required.
3. **Retention:** current retention remains a global platform operation; tenant-specific legal holds and retention policies are not implemented.
4. **Metrics:** admin/publisher operational aggregates remain platform-wide and Public-only for alert data. This is not a tenant-scoped metrics design.
5. **Delivery worker:** the worker has no user or tenant principal. It is limited to Public rows and pauses global queue maintenance if any non-Public outbox row exists. This fail-closed stop is not a recipient-aware dispatcher.

### Current validation status

- The previous exact PR head `2ddab0757740a573933410404b7eeec47101be93` had 217 passing and 5 failing Node tests; CodeQL and the Windows backup/restore job succeeded, while the CAP system test job failed at `npm test`.
- Follow-up commits corrected the observed test-fixture and lifecycle-timing issues and added same-role cross-organization scope coverage. The current head at this checkpoint is `d77c7898912036595344e1dd89043377e0172b61`; its CI result has not yet been returned. Do not treat predecessor checks as validation of this head.
- Restricted/Private remain blocked. `external_adapters_enabled: false` remains unchanged. No real CAP message or external webhook was sent.

The next authorization gate is to define trusted webhook-source attribution and audit-event visibility, then apply a single deny-by-default organization/grant policy to every listed API and background path before any non-Public access is enabled.


## 11. Fail-closed protections for unscoped operational views

A follow-up route audit added temporary protections when at least one organization exists:

- Reviewer access to `GET /api/webhooks/inbox` and `PATCH /api/webhooks/inbox/:id/review` is denied with `WEBHOOK_TENANT_ATTRIBUTION_UNCONFIGURED`. Platform Admin retains global triage access. In single-tenant installations with no organizations configured, the existing Reviewer workflow remains available.
- For non-admin audit readers (Reviewer/Approver), `GET /api/audit` and `GET /api/audit/export.csv` exclude alert-less global events whenever organizations are configured. They can still see alert-linked Public events. Platform Admin retains global audit visibility. `GET /api/audit/verify` remains an integrity-only response and does not return event rows.
- These are temporary deny-by-default mitigations. They do not implement source-to-organization webhook attribution or tenant-scoped audit event storage. Admin remains a platform-wide trust boundary.

The same-role cross-organization integration fixture now creates active memberships for Forecaster, Reviewer, and Publisher accounts in both organizations. It verifies that Reviewer B cannot enumerate or mutate the unscoped webhook inbox, cannot see Organization A's alert-less lifecycle events through audit list/export, and that platform Admin retains the intended global operational view. It also checks direct-ID, XML, relations, versions, timeline, list/export, and outbox boundaries for legacy non-Public alerts.

The delivery worker remains intentionally global but Public-only, with global maintenance paused whenever a non-Public outbox row exists. This is a containment mechanism, not tenant-aware background authorization.


## 12. Opt-in recipient grant enforcement for alert reads and delivery APIs

A deny-by-default enforcement path has now been added behind the explicit environment setting `CAP_NON_PUBLIC_RECIPIENT_ACCESS_ENABLED=true`. The setting is **off by default** and has not been enabled in deployment configuration. The new integration test enables it only inside an isolated temporary test server.

When the flag is enabled:

- A request must identify its active organization using `X-CAP-Organization-ID` (or `organization_id` for collection reads). The server verifies a current, unexpired membership for the authenticated user; the supplied organization ID alone is never trusted.
- Alert list, statistics, CSV export, review queue, detail, CAP XML, relations, review history, versions, and timeline apply the current `read` grant predicate. Collection predicates are applied in SQL before counts, pagination, and export limits.
- The correlated SQL predicate checks the alert's immutable owner, active owner/recipient organizations, active user membership, current grant state and time window, and (for group grants) active group membership tied to the same organization membership.
- Outbox list/count, per-ID concealment, claim, receipt, and retry re-check the current `deliver` grant. Claim/receipt/retry repeat the authorization predicate inside the database mutation, rather than relying only on an earlier route check.
- Platform Admin retains access to owner/grant management routes for non-Public alerts.

The flag remains disabled by default because this is a controlled enforcement path, not production approval. Restricted/Private alert creation and workflow mutation remain blocked. The worker has no tenant principal and remains Public-only; global retry/recovery pauses when any non-Public outbox row exists. `enqueueDelivery` remains Public-only. External adapters remain disabled and no external transmission is performed.

### Required validation before enabling outside tests

- Run the complete CI suite on the exact head and inspect the integration test result.
- Validate the opt-in integration test's positive Organization B grant and negative same-role Organization A access for detail, XML, relations, list, CSV, outbox, claim, receipt, and retry.
- Add independent review/approver role coverage and test revoked/expired membership and grant behavior against every collection and mutation route.
- Define tenant-aware worker identity and job claim/dispatch authorization before any background processing of non-Public deliveries.
- Keep the deployment flag unset until these controls and operational procedures are reviewed and explicitly approved.

## Current-status addendum — 2026-11-08

This addendum supersedes historical statements above that claim organization, membership, recipient-group, grant, or central authorization tables/functions are absent. Historical sections remain a record of the earlier audit, not a description of the current head.

### Implemented technical mechanisms

- Organization and organization-membership schema, lifecycle transitions, active membership checks, and time-window enforcement exist.
- Recipient-group and group-membership schema and lifecycle checks exist.
- Alert ownership and direct, organization, and group recipient grants exist, with read and deliver actions and current membership/grant validity checks.
- The Webhook inbox uses shared current-membership checks, including start and expiry windows.
- Audit list and CSV export use a shared SQL predicate that filters alert-linked events before search, pagination, and export. Public-linked events remain visible. Restricted/Private-linked events require the feature flag, a current membership in the recipient organization, and a matching active read grant. Admin role alone is not a bypass.
- Alert-less audit events are platform-only and visible to the platform administrator route role, not ordinary tenant roles. Alert-linked non-Public events still require a matching recipient grant even for Admin. Chain verification metadata is limited to admin, reviewer, and approver roles and does not expose event rows.
- Two-tenant integration coverage exercises valid direct-grant visibility, same-role no-grant denial, owner-side no-grant denial, future and expired membership denial, admin no-bypass, CSV parity, and alert-less platform event exclusion.

### Remaining gaps and boundaries

- Institutional policy decisions P-01–P-25 remain awaiting approval; technical schema or tests do not constitute approval.
- CAP_NON_PUBLIC_RECIPIENT_ACCESS_ENABLED remains disabled by default and must remain disabled in production until institutional approvals and acceptance are complete.
- Admin is currently the only platform-level route role available for chain-verification metadata; no separate platform-operator role or tenant-visible platform audit view has been institutionally approved.
- Background delivery remains fail-closed for non-Public outbox work; no production Restricted/Private delivery is authorized.
- external_adapters_enabled: false remains mandatory.
- Independent security review, documented restore evidence, external receiver interoperability acceptance, formal operational controls, and signed institutional Gate 8 acceptance remain outstanding.

Do not describe the recipient model as production-ready, OASIS-certified, institutionally accepted, or Gate 8 complete on the basis of these code changes or CI results.


### Additional route-level verification — 2026-11-08

The route-level guard is applied before handler execution for non-Public alert detail, CAP XML, relations, review-history, versions, and timeline reads. The integration pack now verifies that a matching direct read grant permits these reads, while a same-role peer, an owner-side user without a recipient grant, and an administrator without a recipient grant receive concealed 404 responses. A read grant does not authorize review-note mutation. A future-start grant is tested as non-authorizing until its effective window; grant expiry is covered by the existing lifecycle unit test.
