# Recipient Authorization — Institutional Policy Decisions

Status: **decision register only; awaiting institutional approval**.
Implementation status: **technical recipient mechanisms are present in the repository; institutional policy approval remains outstanding**. This register is not authorization to enable Restricted/Private production access.
Security baseline: Public-only behavior remains in force; Restricted/Private remain unavailable through recipient workflows; external delivery adapters remain disabled.

This register is the prerequisite to implementing the agreed technical sequence:
1. Organizations and memberships.
2. Recipient groups and group memberships.
3. Direct, organization, and group grants.
4. Immediate revocation and expiry enforcement.
5. Central enforcement across API and delivery.
6. Cross-organization IDOR tests using users with identical workflow roles.

The repository now contains organization, membership, recipient-group, grant, and central authorization mechanisms. Existing CAP `restriction` and `addresses` fields remain message data, not identity or authorization evidence. The implementation status and remaining institutional controls are recorded below.

## Decision register

| ID | Decision requiring an institutional owner | Options to approve | Secure interim default | Implementation impact | Status |
|---|---|---|---|---|---|
| P-01 | Identity authority | Local account administrators; institutional IdP; trusted provisioning integration | Only existing authenticated account IDs; no inferred identity | Membership verification, account linking, deprovisioning | Awaiting approval |
| P-02 | Membership cardinality | One organization per user; multiple concurrent organizations | Do not assign any membership automatically | Unique constraints, policy evaluation, test fixtures | Awaiting approval |
| P-03 | Organization structure | Flat organizations; parent/child units; delegated sub-units | Flat, isolated organizations until hierarchy is explicitly approved | Tenant boundary and delegated administration | Awaiting approval |
| P-04 | Alert ownership | Immutable owning organization; shared ownership | Immutable owner plus explicit grants; no implicit shared ownership | Alert schema, create/derive/update rules, migration | Awaiting approval |
| P-05 | Restricted semantics | Organization-wide eligible access; explicit user/group grants; combination | Deny unless a valid explicit grant and active membership chain match | Grant evaluation and recipient resolution | Awaiting approval |
| P-06 | Private semantics | Named user only; named group; organization; combinations | Deny unless explicitly granted to a verified stable principal; never trust free-text CAP addresses | Private grant types and CAP address mapping | Awaiting approval |
| P-07 | Grant targets | User; organization; recipient group; approved combinations | Support no target implicitly; only explicitly approved target types | Grant table constraints and policy function | Awaiting approval |
| P-08 | Grant actions | Read; review; edit; approve; publish; deliver; administer recipients | Separate scope access from workflow-role capability; grant does not confer workflow role | Action vocabulary and central authorization contract | Awaiting approval |
| P-09 | Grant authority | Organization owner; recipient administrator; two-person approval; platform operator | No grant administration until designated authority is approved; no Admin bypass | Admin routes, separation of duties, audit | Awaiting approval |
| P-10 | Membership lifecycle | Pending, active, suspended, revoked, expired; provisioning states | Only active, verified, in-window membership authorizes | State machine, approval and audit records | Awaiting approval |
| P-11 | Grant lifecycle | Pending, active, suspended, revoked, expired; optional approval | Only active, approved, in-window grant authorizes | State machine, transactional transitions, indexes | Awaiting approval |
| P-12 | Time semantics | UTC timestamps; institution-local scheduling with UTC storage | Store and compare UTC instants; require explicit timezone at input boundaries | Validation, expiry jobs, deterministic tests | Awaiting approval |
| P-13 | Revocation linearization | Next request; transaction boundary; queued work cancellation policy | Re-check within each protected transaction; block all not-yet-started work after revocation | Locking/transaction strategy, delivery claim checks | Awaiting approval |
| P-14 | In-flight operations | Complete if already authorized; abort where possible; action-specific | Define a transaction commit as the authorization decision point; no new work after revocation | Race tests and API semantics | Awaiting approval |
| P-15 | Queued delivery after revoke/expiry | Cancel queued; re-evaluate before claim; handle already external separately | Re-evaluate membership, grant, alert owner, and expiry before every claim/retry; do not send externally | Outbox state transitions and worker policy | Awaiting approval |
| P-16 | Role separation | Reviewer/Approver distinct; same person permitted; quorum | Keep current routes restricted to Public; require separate actors if dual control is mandated | Workflow state machine and role tests | Awaiting approval |
| P-17 | Publisher boundary | Publisher may operate all authorized tenant queues; per-org publisher; separate delivery operator | Role and tenant/grant checks both required; no global non-Public queue access | Queue scoping, operational permissions | Awaiting approval |
| P-18 | Webhook attribution | One source per organization; multiple keys; central trusted broker | No tenant attribution from payload fields; inbox remains non-tenant/global and non-actionable for recipient grants | Source registry, key rotation, inbox authorization | Awaiting approval |
| P-19 | Audit visibility | Tenant-local events; platform-global events; split views | Alert-linked events follow alert authorization; alert-less events remain platform-only to privileged platform operators | Audit schema, list/export/verification filters | Awaiting approval |
| P-20 | Retention and legal hold | Uniform global policy; per-organization policy; per-record hold | Keep current global behavior; do not introduce tenant-specific deletion or holds without approved rules | Retention partitioning, hold model, audit evidence | Awaiting approval |
| P-21 | Metrics and aggregation | Tenant-scoped; platform-global; split by sensitivity | No non-Public tenant metrics in global aggregates absent explicit approval | SQL pre-aggregation filters and dashboard scope | Awaiting approval |
| P-22 | Session and cache invalidation | Request-time DB check; short-lived cache; event invalidation | Request-time authorization from current persisted state; no stale role/membership/grant cache | Performance design, token versioning, cache purge | Awaiting approval |
| P-23 | Migration of existing data | Explicit manual mapping; trusted directory mapping; remain Public-only | No automatic organization assignment, no default memberships/grants, no scope promotion | Backfill and rollback plan | Awaiting approval |
| P-24 | Break-glass | Prohibited; time-limited exceptional access with independent review | Prohibited until separately approved | Emergency role, notifications, expiry, audit | Awaiting approval |
| P-25 | External delivery activation | Remain disabled; staged adapter activation after acceptance | `external_adapters_enabled: false` | Adapter threat model and end-to-end acceptance | Awaiting approval |

## Required implementation invariants

These invariants are not optional implementation details:

- A workflow role and a recipient grant are independent, conjunctive authorization checks.
- Every non-Public alert has exactly one immutable owning organization unless an explicitly approved sharing model says otherwise.
- No membership or grant is inferred from username, email suffix, sender, CAP `addresses`, or client-supplied organization IDs.
- Client-supplied tenant, owner, group, or grant identifiers are never trusted without server-side relationship checks.
- SQL authorization filters run before pagination, counts, sorting, exports, and aggregation.
- Every detail, XML, relation, history, audit, and download route applies the same central policy.
- Grant and membership state changes are transactional and attributable; revoked or expired access is denied on the next authorization decision.
- Background workers re-evaluate current authorization at claim/retry time; enqueue-time authorization alone is insufficient.
- No migration creates memberships or grants by default; no Restricted/Private data becomes visible merely because schema tables exist.
- Denial tests assert no data disclosure and no state-changing side effect.

## Phase gates and acceptance evidence

### Gate 1 — Organizations and memberships
- Approved P-01 through P-04, P-10, P-12, P-22, and P-23.
- Schema constraints, lifecycle transitions, audit events, migration/rollback tests.
- Two organizations and same-role users; inactive, suspended, revoked, expired, and not-yet-valid membership denial tests.

### Gate 2 — Recipient groups
- Approved organization hierarchy and group ownership rules.
- Group membership lifecycle, no cross-organization membership unless explicitly permitted.
- Tests for group-ID substitution, disabled groups, expiry, and revocation.

### Gate 3 — Grants
- Approved P-05 through P-09 and P-11.
- Direct, organization, and group grants only for approved target types.
- Tests proving a role without a grant is denied and a grant without the required role cannot perform workflow actions.

### Gate 4 — Revocation and expiry
- Approved P-12 through P-15 and P-22.
- Deterministic transaction-boundary semantics; concurrent revoke/read and revoke/claim tests.
- Subsequent API requests and unclaimed/retried delivery work denied after revocation/expiry.

### Gate 5 — API and delivery enforcement
- Complete route inventory coverage, including collection, search, count, pagination, exports, stats, XML, relations, review, audit, metrics, webhooks, outbox, worker, retention, and caches.
- No alternate route or indirect metadata disclosure.
- External adapters remain disabled during this phase.

### Gate 6 — Cross-organization IDOR acceptance
- At minimum Organization A and B; User A and User B have the exact same workflow role.
- A valid grant in A permits only the approved A resource/action.
- B cannot access A by guessed numeric/padded IDs, CAP identifiers, relation traversal, search, pagination, export cursor, group/grant IDs, or background queue identifiers.
- Repeat with direct, organization, and group grants; then with suspended/revoked/expired memberships and grants.
- Run the complete regression suite and CI on the exact PR head before any release decision.

## Approval record

No policy decisions are approved by this file. Record each decision with:
- decision ID;
- approving institution/authority and named role;
- selected option and any exception;
- approval date and review/expiry date;
- linked policy or governance reference.

Until the required decisions are approved, implementation remains design-only and Public-only containment remains the release boundary.

## Technical implementation status — audit authorization (2026-11-08)

The policy decisions above remain **awaiting institutional approval**. Technical mechanisms do not approve P-01–P-25, authorize production Restricted/Private use, or close Gate 8.

- Organization, membership, recipient-group, group-membership, alert-owner, and recipient-grant schema and runtime mechanisms exist. They remain fail-closed by default; CAP_NON_PUBLIC_RECIPIENT_ACCESS_ENABLED is disabled unless explicitly configured.
- Audit list (GET /api/audit) and CSV export (GET /api/audit/export.csv) apply one SQL visibility predicate before search, ordering, pagination, row limits, and export serialization.
- Alert-linked audit rows are visible when the linked alert is Public, or when non-Public recipient access is explicitly enabled and the requester has a current organization membership plus an active, approved, in-window read grant matching the alert owner. Workflow role does not replace the grant. Admin role does not bypass this check.
- Alert-less audit events are platform-only and visible in list/export only to the platform administrator route role; ordinary tenant roles cannot see them. Alert-linked non-Public events still require a matching recipient grant even for Admin. Chain-verification metadata (GET /api/audit/verify) is available to admin, reviewer, and approver roles but exposes chain status only, not event rows.
- Integration tests cover a direct grant, same-role peer without grant, owner-side user without recipient grant, future and expired memberships, administrator without recipient grant, CSV parity, and platform-only event exclusion.
- Existing grant and membership lifecycle unit tests cover grant expiry and membership time windows. Automated checks are technical regression evidence only, not institutional acceptance.

Release boundary remains unchanged: do not enable non-Public access in production, do not activate external adapters, and do not claim Restricted/Private operational readiness until institutional decisions, independent security review, and Gate 8 evidence are complete.


### Additional route-level enforcement coverage

The shared non-Public alert guard also protects detail, CAP XML, relations, review-history, versions, and timeline routes. A read grant authorizes those reads only for the matching recipient identity and organization; it does not authorize review-note mutations. These routes are covered by the two-tenant integration pack. Future-start grants are separately tested as non-authorizing until their effective window.
