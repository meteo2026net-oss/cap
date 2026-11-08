# Operational Readiness and Go-Live Checklist

> **Status: NOT APPROVED FOR OPERATIONAL PUBLIC WARNING ISSUANCE.**
> This checklist is a planning and acceptance record, not a certification. A passing CI run does not establish CAP interoperability, institutional authority, or operational safety. Keep deployments private and use only Test/Exercise data until every applicable gate has been independently accepted.

## 1. Decisions and inputs required from the deploying institution

These are deployment-time decisions; they are not needed to continue repository development.

- [ ] Name the legally/organizationally authorized warning authority and the accountable service owner.
- [ ] Define the geographic responsibility area, supported languages, warning categories, severity/urgency/certainty policy, and public-feed scope.
- [ ] Approve the role roster and separation of duties for authors, reviewers, approvers, publishers, and administrators.
- [ ] Define the approval quorum, escalation path, out-of-hours coverage, correction/cancellation process, and incident ownership.
- [ ] Select the hosting environment, data residency requirements, domain, DNS owner, and HTTPS termination/reverse-proxy design.
- [ ] Identify authoritative forecast/observation sources and document data licensing, freshness, attribution, fallback, and human-verification requirements.
- [ ] Identify each external distribution channel and its official provider specifications, credentials owner, delivery receipts, retry limits, and support contact. No channel is enabled by this checklist.
- [ ] Set availability, recovery-time (RTO), recovery-point (RPO), retention, and service-support targets.

## 2. Identity, access, and governance

- [x] Implement TOTP MFA, encrypted secret storage, one-time recovery codes, and single-use login challenges; automated tests cover enrollment, login, recovery, disable, and TOTP replay prevention.
- [x] Implement recovery-code regeneration after current-password and second-factor verification; invalidate the previous set, revoke existing sessions, and show the replacement set once.
- [x] Implement configurable `MFA_REQUIRED_ROLES` enforcement; protected operations for listed roles are blocked until MFA enrollment is confirmed, while setup endpoints remain accessible.
- [ ] Set the deployment's approved `MFA_REQUIRED_ROLES` policy and complete independent security review.
- [x] Require newly provisioned accounts to replace their initial temporary password before normal access.
- [x] Implement administrator-assisted password reset with a generated temporary password, session revocation, forced change before normal access, audit event, and rate limiting.
- [ ] Implement secure self-service password recovery with verified delivery, expiring single-use tokens, and abuse controls.
- [ ] Enforce institutional identity lifecycle: onboarding, approval, suspension, offboarding, and periodic access review.
- [x] Apply a temporary fail-closed Public-only API policy: lists, detail/XML/history/relations, exports, statistics, review queues, audit listing/export, and delivery views exclude non-Public records; direct non-Public IDs are concealed as 404; new Restricted/Private creation and scope promotion are blocked. Regression tests are added; CI evidence is pending.
- [ ] Design, implement, and independently review the institution-approved recipient-grant model for Restricted and Private messages, including trusted organization/user mapping, deny-by-default read/export/mutation/delivery enforcement, grant/revoke audit events, and multi-account IDOR tests. The addresses field is not an ACL. Keep non-Public workflows disabled until this gate is accepted.
- [ ] Review role separation and last-administrator safeguards against the institution's approved policy.
- [x] Block administrator-assisted password reset when the target is another administrator; verify that the denied request leaves the target credentials unchanged. This does not implement dual authorization for administrator creation/promotion.
- [ ] Define session lifetime, revocation, secret rotation, and emergency account recovery.
- [x] Verify retained audit-chain hash links and detect missing IDs between retained hashed entries; automated tests cover modified records, broken links, unhashed tails, and interior sequence gaps.
- [ ] Define audit retention, external immutable/off-host anchoring, access review, and evidence export.
- [x] Commit alert/user creation, MFA enrollment initiation, privileged delivery transitions, and webhook-inbox review atomically with their audit events; integration tests verify rollback when an audit append fails.
- [ ] Confirm that no shared accounts or default credentials are used.

## External audit checkpoint deployment

The application can maintain an HMAC-SHA256 signed checkpoint after every successful audit append. Configure both variables before enabling it:

- `AUDIT_CHECKPOINT_PATH`: an absolute path on a separately protected, off-host or separately mounted persistent volume. Do not place this file beside the SQLite database on the same writable disk if it is intended to protect against host/database rollback.
- `AUDIT_CHECKPOINT_SECRET`: a unique random secret of at least 32 bytes, stored in the host secret manager and never committed to Git.

For an existing installation, first take a backup and review the current audit-chain verification result. Then initialize the anchor exactly once with `npm run audit:checkpoint:init`. The command refuses to overwrite an existing checkpoint and refuses to anchor an invalid chain. New audit appends update the signed checkpoint; if the checkpoint is missing, stale, or has an invalid signature, subsequent audit writes are refused until an administrator investigates and performs an approved recovery. A stale checkpoint after an interrupted write must not be silently replaced. The manual recovery command `npm run audit:checkpoint:refresh -- --confirm-offhost-evidence` requires an explicit operator confirmation flag after the independent evidence review (the flag is an operator attestation, not cryptographic proof), then verifies the existing checkpoint HMAC, confirms that its anchor remains in the complete verified database chain, and advances it only when the database is not rolled back. Before running it, an administrator must compare the checkpoint against independently protected off-host evidence and review the intervening audit records; a valid local HMAC alone cannot prove that the file is the latest trusted checkpoint. If that comparison fails or no trusted evidence is available, stop and restore a consistent database/checkpoint pair from verified backups rather than re-anchoring.

A valid checkpoint detects deletion or rollback of the anchored tail. The checkpoint storage and secret must be protected independently of the database for this control to provide meaningful off-host assurance. If the checkpoint is stored on the same host and under the same administrator control as SQLite, it does not provide independent protection against a privileged attacker. Back up and monitor the checkpoint separately. Do not claim institutional certification based on this control alone.

## 3. CAP 1.2 conformance and interoperability

- [x] Document the current CAP 1.2 automated conformance matrix, test evidence, coverage boundaries, and remaining receiver-interoperability work in [CAP conformance matrix](CAP_CONFORMANCE_MATRIX.md).
- [x] Generate and XSD-validate Alert, Update, Cancel, Ack, and Error messages in automated tests (local + CI with official OASIS CAP 1.2 schema).
- [x] Cover required/optional fields, enumerations, timestamps/time zones, multilingual blocks, references, resources, geocodes, polygons, circles, altitude/ceiling, and many boundary cases in unit and schema tests.
- [x] Validate generated XML with the official OASIS CAP 1.2 XSD in CI; independent receiving-system validators remain a deployment-time obligation.
- [x] Validate CAP references as complete `sender,identifier,sent` triplets, including invalid-calendar rejection and XML Schema timezone bounds (maximum ±14:00); automated tests cover multiple references and boundary offsets.
- [x] Support Update/Cancel reference chains with preserved historical messages, immutable snapshots, and timeline APIs; integration tests cover derivation and relations.
- [x] Exclude Test/Exercise and non-Public/expired alerts from public JSON and GeoJSON feeds; integration tests assert the isolation rules.
- [x] Restrict public JSON/GeoJSON feeds to CAP Alert, Update, and Cancel message types; Ack and Error control messages are excluded even if stored with Public/Actual/published fields.
- [x] Retain CAP Restricted (restriction text) and Private (addresses) structural validation and XSD coverage, while the HTTP API blocks creating or promoting either scope until recipient grants are implemented. Do not interpret the CAP addresses field as an ACL.
- [ ] Conduct end-to-end interoperability tests with every intended receiving organization/provider using non-operational test endpoints.
- [ ] Obtain written acceptance from the receiving-system owners and the authorized warning authority.

## 4. Hosting and application security

- [ ] Deploy only to a supported, patched host with restricted administrative access.
- [x] Prevent browser/proxy caching of authenticated warning records, CAP XML exports, profile, user administration, authentication/MFA, password-reset, audit, webhook-review, and delivery responses, including unauthenticated warning-API errors; API integration tests assert `Cache-Control: no-store` and `Pragma: no-cache` for the covered sensitive responses.
- [ ] Enable and verify GitHub `main` branch protection: require pull requests and the relevant passing CAP system checks and CodeQL checks, block force pushes and branch deletion, and restrict bypass permissions. The repository's current branch metadata reports protection disabled; re-check the live setting after configuration.
- [ ] Configure HTTPS, secure proxy headers, trusted proxy boundaries, and a reviewed origin/CORS allowlist.
- [ ] Replace all example values with unique secrets stored in the hosting platform's secret manager; never place secrets in Git, tickets, chat, or logs.
- [ ] Keep inbound webhook ingress disabled unless a specific integration has been reviewed, authorized, tested, and has a secret-rotation and replay-response procedure.
- [ ] Keep outbound delivery disabled until a provider adapter, allowlist, authentication, timeout, retry, idempotency, receipt, and failure policy has been implemented and tested.
- [ ] Review dependency vulnerabilities, host and filesystem permissions, network exposure, and software update procedures.
- [ ] Complete independent application, infrastructure, and configuration security testing; track and resolve findings before go-live.
- [ ] Review privacy, records-management, accessibility, and applicable legal/regulatory obligations.

## 5. Backup, recovery, and continuity

- [ ] Define encrypted off-host backup storage, access controls, retention, and deletion policy.
- [x] Provide an optional per-user Windows daily backup task with catch-up scheduling, per-run logs, and a manual backup launcher; verify each backup with SQLite integrity and audit-chain checks.
- [x] Provide a backup inventory command that reports file size/date and verifies each generated backup's checksum, SQLite integrity, and audit chain; flag corrupt backups and ignore unrelated files/symlinks.
- [x] Provide a local backup-health CLI check for missing, corrupt, or stale newest backups, with configurable freshness threshold, JSON output, and non-zero exit status for scheduler/CI consumption; external alert routing remains pending.
- [ ] Configure monitoring/alerting for missed or failed backup jobs and deploy equivalent scheduled automation on non-Windows hosts.
- [x] Expose a database-backed readiness endpoint that checks SQLite quick integrity and foreign-key consistency and returns HTTP 503 when either check fails; API integration tests verify the healthy response.
- [ ] Perform a restore drill in an isolated environment using a production-like backup.
- [x] Provide a read-only post-restore verification CLI that checks SQLite integrity, foreign keys, audit-chain validity, and core users/alerts/audit record counts.
- [x] Provide an isolated restore-drill command that executes the restore path against a temporary target, compares deterministic SHA-256 content fingerprints and row counts across every application table, and removes its temporary workspace; production-like drill evidence remains pending.
- [ ] Verify restored workflow states and CAP references against a production-like backup during an isolated restore drill.
- [ ] Record the drill date, backup identifier, operator, measured recovery time, and result.
- [ ] Document disaster recovery, host loss, credential compromise, and database corruption procedures.

## 6. Monitoring and operational procedures

- [ ] Add centralized application, host, database, and delivery monitoring with alert routing to an accountable on-call team.
- [ ] Define health checks, service-level objectives, log retention, clock synchronization, and alert thresholds.
- [ ] Monitor failed logins, privileged changes, rejected CAP messages, queue age, retry/dead-letter counts, webhook replays, and backup status.
- [ ] Define warning drafting, review, approval, publication, correction, cancellation, and post-event review runbooks.
- [ ] Conduct tabletop exercises and end-to-end drills with the responsible staff.
- [ ] Establish change management, release rollback, dependency patching, and incident communication procedures.

## 7. Go-live acceptance gates

Go-live is blocked until all applicable items below have named evidence and an accountable approver:

1. [ ] Authorized institution signs off on policy, roles, coverage, and operational ownership.
2. [ ] CAP conformance and receiving-system interoperability evidence is accepted.
3. [ ] MFA, account recovery, access controls, and independent security findings are accepted.
4. [ ] HTTPS, secrets management, network boundaries, monitoring, and incident procedures are verified.
5. [ ] Off-host backups and a successful isolated restore drill are evidenced.
6. [ ] Every external distribution channel has passed provider-approved end-to-end tests and explicit authorization.
7. [ ] Final operational acceptance is recorded by the institution; development/engineering sign-off alone is insufficient.

## 8. Current repository boundary

The current application is a development foundation. It has a local SQLite-backed workflow, CAP XML generation/schema checks, public JSON/GeoJSON feeds, audit logging, an internal delivery outbox, and an optional inbound manual-review inbox. The maintenance worker does not send messages. No external CAP, email, SMS, push, or government gateway transport is currently enabled. The inbound webhook receiver is disabled by default and does not create or publish alerts.

The current CI suite and CodeQL are useful automated checks, but they do not replace the acceptance gates above. Do not describe this repository as certified, institutionally approved, or production-ready for public-warning issuance until those gates have been completed and independently evidenced.


## Account and recipient authorization review
- [x] Code-level review of account lifecycle, session invalidation, role guards, MFA controls, and current recipient-scope containment recorded in [ACCOUNT_AND_RECIPIENT_AUTHORIZATION_REVIEW.md](ACCOUNT_AND_RECIPIENT_AUTHORIZATION_REVIEW.md).
- [ ] Institution must approve the role/approval matrix, trusted organization and recipient identity source, geographic/temporal grant semantics, grant/revoke lifecycle, MFA-required roles, and account recovery process.
- [ ] Implement and independently test recipient grants before enabling Restricted or Private operations. Keep the Public-only boundary in place until the multi-user/multi-organization IDOR and revocation test matrix is accepted.


## Recipient authorization design proposal
- [x] Drafted [RECIPIENT_AUTHORIZATION_DESIGN.md](RECIPIENT_AUTHORIZATION_DESIGN.md) with a deny-by-default conceptual model, identity prerequisites, enforcement inventory, revocation semantics, and multi-organization negative/positive test matrix.
- [ ] This proposal is not institution-approved and is not implemented. Do not create grants or enable Restricted/Private workflows until the identity authority, organization hierarchy, recipient semantics, role separation, expiry/revocation, and operational controls are approved.


## Delivery and background recipient-scope audit
- [x] Reviewed every current delivery state transition and background queue-maintenance path; recorded the findings in [DELIVERY_RECIPIENT_SCOPE_AUDIT.md](DELIVERY_RECIPIENT_SCOPE_AUDIT.md).
- [x] Added Public-scope SQL enforcement to enqueue, claim, receipt, retry, automatic retry, and stale-lease recovery paths, with negative unit and API regression coverage.
- [ ] Recipient grants, identity verification, expiry/revocation semantics, and institution-approved queue behavior remain prerequisites before any Restricted/Private delivery or external adapter is enabled.


## Role authorization review

- [x] Completed a source-and-test role audit for Reviewer, Approver, Forecaster, Publisher, Viewer, and Admin; findings and open policy decisions are in [ROLE_AUTHORIZATION_AUDIT.md](ROLE_AUTHORIZATION_AUDIT.md).
- [x] Enforced forecaster ownership on draft submission, matching the existing draft-edit ownership check; a second forecaster cannot submit another user's draft.
- [ ] Institution must approve the distinct reviewer/approver workflow, approval quorum, conflict-of-interest rules, publisher/delivery-operator boundary, and admin override/dual-control policy before operational acceptance.


## Recipient authorization gap audit

- [x] Inspected the current SQLite schema, API scope guards, collection/export/review/relations/audit/delivery paths, and existing scope-isolation integration tests.
- [x] Documented that organization, membership, recipient-group, grant, and grant-audit entities and a central recipient policy are not implemented.
- [x] Added the required multi-organization IDOR, membership lifecycle, grant revocation, race/TOCTOU, indirect disclosure, and delivery regression plan in [RECIPIENT_AUTHORIZATION_GAP_AUDIT.md](RECIPIENT_AUTHORIZATION_GAP_AUDIT.md).
- [ ] Institution must approve identity authority, organization hierarchy, membership lifecycle, grant semantics, dual-control policy, and revocation behavior before implementation.
- [ ] Implement and pass real two-organization cross-tenant IDOR tests before enabling Restricted/Private.


- [x] Extended the recipient gap audit with a route/background-worker inventory covering alerts, CAP XML/relations, review/version/timeline, webhooks, audit, metrics, retention, user administration, outbox, and retry/recovery.
- [x] Identified global webhook inbox attribution, alert-less audit event visibility, global retention, aggregate metrics, and worker principal-context as additional multi-organization design gates.
