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
- [ ] Review role separation and last-administrator safeguards against the institution's approved policy.
- [ ] Define session lifetime, revocation, secret rotation, and emergency account recovery.
- [x] Verify retained audit-chain hash links and detect missing IDs between retained hashed entries; automated tests cover modified records, broken links, unhashed tails, and interior sequence gaps.
- [ ] Define audit retention, external immutable/off-host anchoring, access review, and evidence export.
- [x] Commit alert/user creation, MFA enrollment initiation, privileged delivery transitions, and webhook-inbox review atomically with their audit events; integration tests verify rollback when an audit append fails.
- [ ] Confirm that no shared accounts or default credentials are used.

## 3. CAP 1.2 conformance and interoperability

- [ ] Expand validation beyond the current generated sample to a documented CAP 1.2 conformance matrix.
- [ ] Test Alert, Update, Cancel, Ack, and Error message handling against applicable OASIS CAP 1.2 rules and receiving-system profiles.
- [ ] Test required/optional fields, enumerations, timestamps/time zones, multilingual blocks, references, resources, geocodes, polygons, circles, altitude/ceiling, and boundary cases.
- [ ] Validate generated XML with the official OASIS CAP 1.2 XSD and independent receiving-system validators.
- [x] Validate CAP references as complete `sender,identifier,sent` triplets, including invalid-calendar rejection and XML Schema timezone bounds (maximum ±14:00); automated tests cover multiple references and boundary offsets.
- [ ] Test Update/Cancel reference chains and ensure historical messages are preserved.
- [ ] Verify that Test/Exercise messages cannot enter public operational feeds.
- [ ] Conduct end-to-end interoperability tests with every intended receiving organization/provider using non-operational test endpoints.
- [ ] Obtain written acceptance from the receiving-system owners and the authorized warning authority.

## 4. Hosting and application security

- [ ] Deploy only to a supported, patched host with restricted administrative access.
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
