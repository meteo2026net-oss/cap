# Meteo CAP Warning System

Standalone Arabic-first weather-warning management starter based on the OASIS Common Alerting Protocol (CAP) 1.2.

## Run locally (without Docker)

Requirements: Node.js 22+ and npm. Docker is **not required** for this mode. From the repository root, run:

```bash
npm run setup:local
npm ci
npm test
npm start
```

The committed `package-lock.json` pins the full dependency tree; `npm ci` installs those exact locked versions and fails if the manifest and lockfile disagree. The setup command creates `.env` (without overwriting an existing file), generates a unique JWT secret, initial administrator password, and persistent MFA encryption key, and creates local data folders. To require MFA for selected roles, set `MFA_REQUIRED_ROLES` in `.env` (for example `admin,approver,publisher`); leave it empty for opt-in MFA. Save the displayed initial password. Open http://localhost:8095. Stop with Ctrl+C. The interactive map uses Leaflet and OpenStreetMap tiles and therefore needs internet access.

For full Windows PowerShell, Linux/macOS, Docker Compose, backup, restore, and troubleshooting instructions, see [Installation guide](docs/INSTALLATION.md).

Dependency maintenance: use `npm ci` for normal installs and CI. When intentionally adding, removing, or upgrading a dependency, use `npm install <package>@<version>`, review both `package.json` and `package-lock.json`, then run `npm ci`, `npm test`, and `npm audit` before committing both files.

## Database backup and restore

A verified SQLite backup can be created from the project directory:

```bash
npm run backup
```

Backups are written to `backups/` by default, validated with SQLite integrity checks and audit-chain verification, and old generated backup files are pruned after 30 days. Set `BACKUP_DIR` and `BACKUP_RETENTION_DAYS` to change these defaults.

To restore, stop the service first, then run:

```bash
npm run restore -- backups/cap-YYYYMMDDTHHMMSSZ.sqlite
```

The restore command refuses to overwrite an existing database unless `--force` is supplied. With `--force`, the previous database is retained beside the restored file as a pre-restore copy. Confirm the restored service and its data before removing that copy. In Docker, create a backup with `docker compose exec cap node src/backup.js`. For restoration, follow the complete Docker procedure in [Installation guide](docs/INSTALLATION.md#mode-b--run-with-docker-compose): stop the app, checkpoint and close SQLite, remove sidecars only after a successful checkpoint, then restore and verify service health. The restore helper intentionally refuses to proceed while WAL/SHM sidecars exist. The backup volume remains mounted in the one-off container. Keep a separate off-host copy; a backup stored on the same host is not disaster recovery.

## Audit integrity

New audit entries are linked with SHA-256 hashes. Administrators, reviewers, and approvers can check the chain through the authenticated `GET /api/audit/verify` endpoint. Existing audit entries from before this migration are preserved and reported separately as legacy unhashed entries. A local hash chain detects accidental or partial tampering; it is not a substitute for externally anchored signatures or immutable off-host storage.

## Docker deployment

Requirements: Docker Engine with the Compose plugin.

1. Copy `.env.example` to `.env`.
2. Replace `JWT_SECRET` and `ADMIN_PASSWORD` with unique secrets (32+ and 14+ characters respectively).
3. Build and start the service:

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f cap
```

The service listens on `127.0.0.1:8095` by default and stores SQLite data in the persistent `cap-data` volume. Put it behind a properly configured HTTPS reverse proxy before remote access; do not expose the container port directly to the public internet. Back up the Docker volume before upgrades. To stop the service without deleting data, run `docker compose down`.

## Current starter features

- Arabic RTL dashboard.
- SQLite schema and initial administrator bootstrap.
- JWT login, authenticated password changes, administrator provisioning for institutional roles, and TOTP MFA with configurable enforcement for selected roles through `MFA_REQUIRED_ROLES`.
- Login uses a dummy bcrypt comparison for unknown/inactive accounts to reduce username-enumeration timing differences; malformed and oversized credentials are rejected before password verification.
- Per-user token-version enforcement: password changes revoke all previously issued sessions and return a replacement token for the current session.
- Draft -> pending review -> approved -> internal publication workflow with independent creator/reviewer/publisher separation; submit, approve, and publish transitions use immediate SQLite transactions and conditional state updates to reject duplicate/stale transitions, with audit records committed atomically.
- CAP 1.2 XML export with numeric-offset timestamps, multiple language blocks, multiple categories/response types, multiple affected areas, geocodes, altitude/ceiling, parameters and supplemental resources.
- Dashboard advanced JSON editor for multilingual information blocks and supplemental resources.
- Dashboard actions and API support for linked Update and Cancel drafts; derived messages remain in Test status pending independent review.
- Administrator account activation/deactivation, role changes, and audited password resets. Password resets issue a generated temporary password once, revoke all sessions, and require a password change before application access; role changes revoke existing sessions.
- Successful sign-ins update a persistent last-login timestamp, visible to administrators in the account-management panel; each successful sign-in is also recorded in the append-only, hash-chained audit history. Restricted audit history supports bounded cursor pagination. Existing SQLite databases are upgraded automatically.
- GitHub Actions downloads the official OASIS CAP 1.2 XSD and validates a generated multilingual XML example with xmllint.
- Public JSON feed for published Public-scope `Actual` alerts, including multilingual `info_blocks`, geometry, references, and CAP metadata.
- Public JSON and GeoJSON feeds automatically exclude alerts whose CAP `expires` timestamp has passed; alerts without an expiry remain available until administratively superseded or cancelled.
- Public GeoJSON feed for published Public-scope `Actual` alerts; CAP polygons are converted to GeoJSON longitude-latitude coordinate order and CAP circles are represented as points with `radius_km` metadata.
- Interactive Leaflet map for published public alerts, severity-aware symbols, circle-radius rendering, local GeoJSON preview/import, and public GeoJSON download. Imported files are preview-only and are not persisted.
- Append-only audit log enforced by SQLite update/delete triggers, SHA-256 hash chaining for new entries, input-size limits, and an authenticated chain-verification endpoint; pre-migration entries remain explicitly identified as unhashed.
- Basic validation of required CAP fields, enumerations, date ordering, closed polygons, and circle geometry.
- CAP `status` is restricted to the four CAP 1.2 values (`Actual`, `Exercise`, `System`, `Test`); `draft`, `pending`, `approved`, and `published` are internal workflow states and are never emitted as CAP status values.
- Optional internal delivery worker for stale-lease recovery and due-retry/dead-letter maintenance (no outbound network delivery).
- GitHub Actions runs Node 22 syntax checks, automated tests, official CAP 1.2 XSD validation, npm audit reporting, Docker image build and container health smoke test.
- Scheduled CodeQL static analysis and Dependabot dependency updates.
- Optional signed inbound webhook endpoint (disabled by default) verifies timestamped HMAC-SHA256 signatures, rejects replays, limits JSON bodies to 64 KB, and stores accepted messages in a persistent manual-review inbox without creating or publishing alerts.
- Role-protected webhook inbox listing and one-way pending-to-reviewed/rejected review decisions for administrators and reviewers, with audit entries.
- Automated Node.js tests for identifiers, CAP validation, geometry, dates, XML export, audit immutability, API role separation, linked Update/Cancel references, public feed filtering, GeoJSON output, legacy lease migration, webhook replay protection and inbound webhook review.

## API

- `GET /api/health`
- `POST /api/auth/login`
- `GET /api/me`
- `POST /api/auth/change-password`
- `GET /api/auth/mfa/status`, `POST /api/auth/mfa/enroll`, `POST /api/auth/mfa/confirm`, and `POST /api/auth/mfa/disable`
- `GET /api/users` (admin only)
- `POST /api/users` (admin only; provisions admin/forecaster/reviewer/approver/publisher/viewer accounts)
- `POST /api/users/:id/password-reset` (admin only; issues a temporary password once, revokes existing sessions, and forces password change before normal application access)
- `PATCH /api/users/:id/status` (admin only; activates/deactivates an account with last-admin safeguards and revokes existing sessions on state changes)
- `PATCH /api/users/:id/role` (admin only; changes an account role, prevents self/last-admin demotion, and revokes existing sessions)
- `GET /api/alerts`
- `GET /api/alerts/:id`
- `POST /api/alerts`
- `POST /api/alerts/:id/derive` (creates a linked Update or Cancel draft with Test status)
- `POST /api/alerts/:id/submit`
- `POST /api/alerts/:id/approve`
- `POST /api/alerts/:id/publish`
- `GET /api/alerts/:id/cap.xml`
- `GET /api/public/alerts`
- `GET /api/public/alerts.geojson`
- `POST /api/webhooks/inbound` (optional; disabled unless `CAP_WEBHOOK_INGRESS_ENABLED=true` and a unique `CAP_WEBHOOK_SECRET` of at least 32 bytes is configured; requires `X-Webhook-Timestamp` and `X-Webhook-Signature`; accepted messages are stored for manual review only)
- `GET /api/webhooks/inbox` (admin/reviewer only; optional `status` filter and `before_id` cursor for bounded 100-message pages)
- `PATCH /api/webhooks/inbox/:id/review` (admin/reviewer only; changes a pending message to `reviewed` or `rejected`; no automatic alert creation or publication)
- `GET /api/audit`
- `GET /api/delivery/outbox` (admin/publisher only; filter with `?status=queued|sending|delivered|failed|dead_letter`)
- `POST /api/delivery/outbox/:id/claim` (claims a queued job and returns its CAP XML payload; does not transmit externally)
- `POST /api/delivery/recover-stale` (admin/publisher only; recovers claims older than `staleMinutes`, default 10, maximum 1440; claims that already exhausted their attempt limit are moved to dead-letter and reported separately)
- `POST /api/delivery/process-retries` (admin/publisher only; requeues failed jobs whose exponential-backoff delay has elapsed and marks exhausted jobs as dead-letter)
- `GET /api/delivery/outbox?status=dead_letter` (admin/publisher only; lists exhausted jobs; every response also includes database-wide counts for queued, sending, failed, delivered, and dead-letter states, independent of the 500-row display limit)
- `POST /api/delivery/outbox/:id/receipt` (records a delivered/failed receipt only with the unique lease token returned by the matching claim (only its SHA-256 digest is stored); stale worker receipts are rejected)
- `POST /api/delivery/outbox/:id/retry` (requeues a failed job for controlled retry)

## Important safety and deployment notes

This repository is an initial development foundation, not a certified or production-ready public warning service. Publishing currently exposes approved alerts through the public JSON endpoint only when their CAP status is `Actual` and scope is `Public`; Test and Exercise messages are excluded. No external CAP distribution, email, SMS, push, or government alert gateway is configured. Publishing now creates an idempotent `cap_feed` outbox job in the same database transaction as internal publication. Stale `sending` leases can be recovered to `queued` after a configurable timeout; recovery actions are audited. Authorized administrators and publishers can monitor the outbox in the Arabic dashboard, process due retries, inspect the dead-letter queue, claim jobs, record receipts, and manually requeue eligible failures. The worker performs internal queue maintenance only (stale lease recovery and retry scheduling); it does not claim or transmit jobs. The optional inbound webhook receiver is wired to the HMAC-SHA256 timestamped signature verifier and atomic SQLite-backed replay cache. It is disabled by default; when deliberately enabled with a unique secret, it accepts bounded JSON messages into a persistent inbox for manual review only. It does not create, approve, or publish alerts, and no outbound network delivery is connected or enabled. `external_adapters_enabled` is hard-coded to false; environment variables cannot enable transmission, and no transport adapter is implemented. The dashboard includes an administrator-only account provisioning panel with role changes and account activation/deactivation, plus an advanced JSON editor for multilingual CAP info blocks. Optional per-account TOTP MFA is available with encrypted secrets, one-time recovery codes, replay-resistant login challenges, and password-plus-second-factor disable. Secure password recovery and policy enforcement of MFA for privileged roles remain pending; account activation/deactivation is available with last-administrator safeguards.

Before operational use, expand the existing official CAP 1.2 XSD check into a complete conformance suite across all CAP message types, profiles, signatures, edge cases, and institutional interoperability scenarios, complete account lifecycle controls (including privileged-role MFA policy enforcement and secure password recovery), HTTPS, backups, monitoring, security testing, and institution-specific authorization and approval procedures. Keep deployments private until these controls are completed. Use Test/Exercise messages during development, and configure unique non-placeholder `JWT_SECRET` and `ADMIN_PASSWORD` values before startup.

## Operational readiness

Before any institutional or public-warning deployment, use the [Operational Readiness and Go-Live Checklist](docs/OPERATIONAL_READINESS.md). It records the decisions, independent evidence, and acceptance gates still required; it does not certify the system.

## Roadmap

See [docs-architecture.md](docs-architecture.md) for the staged delivery plan.

## Security

See [Security operations and deployment boundaries](docs/SECURITY.md) for current safeguards, deployment precautions, and known limitations. This project is a development foundation and is not certified for operational public-warning issuance.

