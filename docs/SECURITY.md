# Security operations and deployment boundaries

This guide describes the current security controls and the precautions required when evaluating this project. It is not a security certification or a substitute for an institutional threat model and independent review.

## Current safeguards

- The application refuses to start when the JWT secret is missing, a placeholder, or shorter than 32 characters, or when the administrator password is missing, a placeholder, or shorter than 14 characters.
- `npm run setup:local` generates a unique JWT secret and initial administrator password and creates the local `.env` file with restrictive permissions. Save the displayed initial password securely; it is not displayed again.
- Passwords are hashed with bcrypt. Login failures use a generic response, and unknown/inactive accounts perform a dummy bcrypt comparison to reduce account-enumeration timing differences.
- Authenticated sessions expire after eight hours. Password changes, account deactivation, and role changes increment the account token version and invalidate prior sessions.
- Role checks, transactional last-active-administrator protections, rate limits, Helmet security headers, a restrictive Content Security Policy, and server-side request validation are implemented.
- The audit log uses append-only database guards and a SHA-256 hash chain. The authenticated verification endpoint detects inconsistencies in the retained chain.
- Docker runs as the non-root Node user with a read-only root filesystem, dropped Linux capabilities, no-new-privileges, a process limit, and a restricted temporary filesystem.
- SQLite backup and restore helpers validate database integrity, foreign keys, and the audit chain. Restore refuses to proceed while SQLite WAL/SHM sidecars exist.

## Required deployment precautions

1. Keep the service private during development and evaluation. Docker Compose binds the host port to loopback by default. Do not publish the container port directly to the internet.
2. For remote institutional evaluation, place the service behind an institution-approved HTTPS reverse proxy, restrict inbound network access, and review proxy, request-size, timeout, and logging settings. Do not assume this application has been hardened for an arbitrary reverse-proxy topology.
3. Use unique, high-entropy values for `JWT_SECRET`, `ADMIN_PASSWORD`, and (only if ingress is deliberately enabled) `CAP_WEBHOOK_SECRET`. Never commit `.env`, database files, backup files, tokens, or webhook signatures.
4. Change the initial administrator password after first sign-in. Create named accounts with the minimum required roles; avoid shared accounts and unnecessary administrator privileges.
5. Keep `CAP_WEBHOOK_INGRESS_ENABLED=false` unless a reviewed integration requires inbound messages. If enabled, use a unique secret of at least 32 bytes, restrict the sender/network at the perimeter, rotate the secret under a documented procedure, and review every inbox item manually.
6. Keep external delivery adapters disabled. The current outbox is an internal queue; a recorded receipt is not proof that a real-world warning was transmitted or received.
7. Back up the database regularly and copy encrypted backups to a separate, access-controlled host or storage account. A backup on the same machine or Docker host is not disaster recovery. Test restoration periodically in an isolated environment.
8. Protect access to the Docker daemon, host account, persistent volumes, backup locations, GitHub repository settings, and CI secrets. A person with host/database control can alter or replace the database and its local audit history.
9. Review dependency alerts and update pull requests. Run `npm audit`, the automated tests, the official CAP schema validation, Docker smoke tests, and CodeQL against the exact release commit before deployment.
10. Establish institutional operating procedures for alert authoring, review, approval, publication, revocation, escalation, incident response, retention, and staff training before any operational use.

## Supply-chain and browser-asset considerations

- The dashboard loads Leaflet and Leaflet.draw assets from the third-party `unpkg.com` CDN. The Leaflet 1.9.4 CSS and JavaScript references include Subresource Integrity attributes; the Leaflet.draw 1.0.4 CSS and JavaScript references currently do not. The Content Security Policy permits these CDN resources. CDN compromise, package replacement, or availability failures can therefore affect the browser dashboard. Before operational deployment, evaluate self-hosting reviewed, pinned assets or adding verified integrity metadata for every external asset.
- The repository currently has no committed `package-lock.json`. CI and the Docker build resolve semver dependency ranges at install time, so separate builds may not install an identical dependency tree. Treat this as a reproducibility and supply-chain limitation: generate and review a lockfile, use `npm ci` in CI and image builds, and update dependencies through reviewed changes before relying on repeatable releases.

## Important limitations

- The audit hash chain is stored in the same SQLite database. It can detect changes within the retained chain, but cannot independently prove that the database or the complete chain was not replaced, truncated, or deleted by an attacker with database-level control. Use externally retained, signed checkpoints or an independent append-only audit service for stronger evidence.
- Multi-instance PostgreSQL support, MFA, password recovery, configurable approval policies, external audit anchoring, scheduled off-host backups, monitoring/alerting, formal CAP interoperability testing, and external delivery adapters are not implemented.
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
