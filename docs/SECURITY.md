# Security operations and deployment boundaries

This guide describes the current security controls and the precautions required when evaluating this project. It is not a security certification or a substitute for an institutional threat model and independent review.

## Current safeguards

- The application refuses to start when the JWT secret is missing, a placeholder, or shorter than 32 characters, or when the administrator password is missing, a placeholder, or shorter than 14 characters.
- `npm run setup:local` generates a unique JWT secret, initial administrator password, and persistent MFA encryption key and creates the local `.env` file with restrictive permissions. Save the displayed initial password securely; it is not displayed again.
- Passwords are hashed with bcrypt. Login failures use a generic response, and unknown/inactive accounts perform a dummy bcrypt comparison to reduce account-enumeration timing differences.
- Authenticated sessions expire after eight hours. Password changes, administrator-assisted password resets, account deactivation, and role changes increment the account token version and invalidate prior sessions.
- MFA login challenges are purpose-bound, short-lived credentials. The general authentication middleware rejects challenge-purpose tokens as sessions; only the dedicated MFA challenge endpoint can exchange one for a full session after second-factor verification.
- Newly provisioned accounts are required to replace their initial temporary password before accessing application data. Administrators can also issue a cryptographically random temporary password for another active account. The value is returned once, stored only as a bcrypt hash, forces a password change before application data or operations are available, and revokes existing sessions. The endpoint is rate-limited and audited; it does not send email or expose the temporary password in audit records.
- Role checks, configurable `MFA_REQUIRED_ROLES` enforcement, transactional last-active-administrator protections, rate limits, Helmet security headers, a restrictive Content Security Policy, and server-side request validation are implemented. MFA enforcement is applied in the authentication middleware, not only in role gates: accounts in a listed role cannot reach authenticated data or operational routes until MFA enrollment is confirmed. Only the profile and password/MFA setup endpoints remain available during enrollment; blocked requests return `403` with code `MFA_REQUIRED`.
- The audit log uses append-only database guards and a SHA-256 hash chain. The authenticated verification endpoint detects changed entries, broken hash links, unhashed records appended after chain activation, and missing IDs between retained hashed entries. A valid result does not prove that the final entries or the database itself were not removed or replaced; retain signed checkpoints outside this database.
- SQLite backup and restore helpers validate database integrity, foreign keys, and the audit chain. Restore refuses to proceed while SQLite WAL/SHM sidecars exist.

## CAP scope authorization — temporary fail-closed boundary

The application does not yet have an institution-approved recipient/grant model for CAP Restricted and Private messages. Role names such as administrator, reviewer, approver, publisher, or forecaster are not treated as implicit recipient grants.

Until that model is implemented and approved, the API applies a temporary Public-only policy:
- Authenticated alert lists, detail reads, CSV exports, statistics, review queues, CAP XML, versions, review history, timelines, and relationship traversal expose Public-scope records only. A direct request for a non-Public record returns the same 404 response as a missing record.
- Relationship traversal filters both parent and child candidates to Public, preventing a Public root from revealing a Restricted/Private linked message. Recipient-only CAP fields (restriction/addresses) are also suppressed from Public detail, XML, CSV, review-queue, and historical-version responses, including legacy Public rows that still contain those columns.
- New Restricted/Private alerts and promotion of a Public draft into either non-Public scope are rejected with SCOPE_AUTHORIZATION_UNCONFIGURED.
- Generic audit listing/export and operational metrics omit events/aggregates attached to non-Public alerts. Delivery outbox listing/counts are Public-only; direct operations on non-Public deliveries are hidden, and global retry/recovery maintenance is blocked while any non-Public outbox row exists.
- Public JSON/GeoJSON feeds retain their separate published + Public + Actual + unexpired + Alert/Update/Cancel filters.

This is deliberately restrictive and may hide existing non-Public records from normal application workflows. Do not use Restricted or Private CAP messages in this deployment. Existing records remain in the database for controlled migration; do not delete or reclassify them to bypass the policy. Re-enable non-Public workflows only after a reviewed recipient-grant schema, trusted identity/organization mapping, deny-by-default enforcement across every read/export/mutation/delivery path, audit of grant/revoke changes, and multi-account IDOR regression tests are implemented and accepted. The addresses field is not an authorization mechanism.

## Required deployment precautions

1. Keep the service private during development and evaluation. Bind it to localhost by default; do not expose the application port directly to the internet.
2. For remote institutional evaluation, place the service behind an institution-approved HTTPS reverse proxy, restrict inbound network access, and review proxy, request-size, timeout, and logging settings. Do not assume this application has been hardened for an arbitrary reverse-proxy topology.
3. Use unique, high-entropy values for `JWT_SECRET`, `ADMIN_PASSWORD`, and (only if ingress is deliberately enabled) `CAP_WEBHOOK_SECRET`. If an account enrolls in MFA, also configure a persistent 32-byte `MFA_ENCRYPTION_KEY` (64 hex characters or base64) and protect it separately from the database; losing it prevents decryption of enrolled TOTP secrets. Never commit `.env`, database files, backup files, tokens, or webhook signatures.
4. Change the initial administrator password after first sign-in. Create named accounts with the minimum required roles; avoid shared accounts and unnecessary administrator privileges. Transfer administrator-issued temporary passwords to the account owner through a separate, institution-approved secure channel; never place them in GitHub, audit notes, ordinary chat, or shared tickets.
5. Keep `CAP_WEBHOOK_INGRESS_ENABLED=false` unless a reviewed integration requires inbound messages. If enabled, use a unique secret of at least 32 bytes, restrict the sender/network at the perimeter, rotate the secret under a documented procedure, and review every inbox item manually.
6. Keep external delivery adapters disabled. The current outbox is an internal queue; a recorded receipt is not proof that a real-world warning was transmitted or received.
7. Back up the database regularly and copy encrypted backups to a separate, access-controlled host or storage account. A backup on the same machine is not disaster recovery. Test restoration periodically in an isolated environment.
8. Protect access to the host account, database files, backup locations, GitHub repository settings, and CI secrets. A person with host/database control can alter or replace the database and its local audit history.
9. Review dependency alerts and update pull requests. Run `npm audit`, the automated tests, the official CAP schema validation, direct-mode startup, backup, and restore tests, and CodeQL against the exact release commit before deployment.
10. Establish institutional operating procedures for alert authoring, review, approval, publication, revocation, escalation, incident response, retention, and staff training before any operational use.

## Repository governance

The current GitHub `main` branch reports branch protection disabled. Before accepting operationally relevant changes, configure and verify repository rules that require reviewed pull requests and passing CAP system checks plus CodeQL, prevent force pushes and branch deletion, and tightly restrict bypass permissions. A checklist entry or a green workflow run does not itself enable these repository settings.

## Supply-chain and browser-asset considerations

- The dashboard loads Leaflet 1.9.4 from `unpkg.com` and Leaflet.draw 1.0.4 from `cdnjs.cloudflare.com`. All four external CSS/JavaScript assets include pinned Subresource Integrity hashes, `crossorigin="anonymous"`, and `referrerpolicy="no-referrer"`; automated static-asset tests guard these attributes and the Leaflet.draw hashes. The Content Security Policy permits these CDN origins. SRI detects unexpected asset-content changes, but CDN availability failures can still affect the browser dashboard; before operational deployment, consider reviewed, pinned self-hosted assets.
- The repository commits `package-lock.json`; CI uses `npm ci` so dependency resolution is reproducible against the reviewed lockfile. Review dependency updates and vulnerability reports before merging.

## Important limitations

- The audit hash chain is stored in the same SQLite database. It can detect changes within the retained chain, but cannot independently prove that the database or the complete chain was not replaced, truncated, or deleted by an attacker with database-level control. Use externally retained, signed checkpoints or an independent append-only audit service for stronger evidence.
- TOTP MFA with AES-256-GCM encrypted secrets, one-time recovery codes, short-lived single-use login challenges, time-step replay prevention, password-plus-second-factor disable controls, and recovery-code rotation with full invalidation of the previous set and session revocation is implemented. MFA remains opt-in unless the operator configures `MFA_REQUIRED_ROLES` (for example, `admin,approver,publisher`). Listed roles cannot use role-protected operations until MFA enrollment is confirmed, but can still authenticate and access MFA setup endpoints. Secure self-service password recovery with verified delivery of expiring single-use tokens remains outstanding; the implemented administrator-assisted reset is a manual recovery path and does not send email. Multi-instance PostgreSQL support, external audit anchoring, scheduled off-host backups, monitoring/alerting, formal CAP interoperability testing, and external delivery adapters also remain outstanding.
- The inbound webhook endpoint only stores authenticated JSON messages for human triage. It does not create, approve, or publish alerts.
- The internal CAP feed and outbox do not provide a public-warning distribution network. No external email, SMS, push, government gateway, or provider delivery is enabled.
- Passing automated tests and CodeQL does not establish regulatory compliance, operational resilience, or fitness for public-warning issuance.

## Pre-deployment review

Do not authorize operational use until the responsible institution has completed and documented:

- independent application, infrastructure, and dependency security review;
- HTTPS, network segmentation, access-control, and secrets-management review;
- backup recovery and disaster-recovery exercises;
- CAP conformance and end-to-end interoperability tests with intended receiving systems;
- role separation, approval policy, audit retention, and incident-response approval;
- operational training, monitoring, support ownership, and change-management procedures.


## Temporary Public-only CAP scope boundary
Recipient-level authorization for Restricted and Private alerts is not implemented. The application therefore fails closed: authenticated API collection, statistics, review, audit, delivery, export, and alert-linked detail paths expose Public alerts only. Direct identifiers for non-Public alerts are concealed as not found. New non-Public messages and valid scope promotions are blocked until an institution-approved recipient-grant model exists. Structurally incomplete CAP requests are still rejected by CAP validation and are not persisted; the temporary scope denial applies after required scope fields are present. Legacy non-Public records remain stored but are not available through the application API. This is a containment measure, not a recipient authorization implementation.

- A source-and-test review of account lifecycle, role boundaries, MFA configuration, recipient identity, and the Restricted/Private reopening gate is maintained in [ACCOUNT_AND_RECIPIENT_AUTHORIZATION_REVIEW.md](ACCOUNT_AND_RECIPIENT_AUTHORIZATION_REVIEW.md). The review records that reviewer and approver currently share the same route permissions, MFA is opt-in unless `MFA_REQUIRED_ROLES` is configured, and no organization/recipient grant model exists.
