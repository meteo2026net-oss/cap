# Meteo CAP Warning System

Standalone Arabic-first weather-warning management starter based on the OASIS Common Alerting Protocol (CAP) 1.2.

## Run locally

Requirements: Node.js 20+ and npm.

1. Clone this repository.
2. Copy `.env.example` to `.env`.
3. Set a unique random `JWT_SECRET` (at least 32 characters).
4. Change `ADMIN_PASSWORD` before starting.
5. Install and run:

```bash
npm install
npm test
npm start
```

Open http://localhost:8095. The interactive map uses Leaflet, OpenStreetMap tiles, and internet access; map tiles are provided by OpenStreetMap's public tile service.

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

The restore command refuses to overwrite an existing database unless `--force` is supplied. With `--force`, the previous database is retained beside the restored file as a pre-restore copy. Confirm the restored service and its data before removing that copy. In Docker, create a backup with `docker compose exec cap node src/backup.js`. To restore, first stop the app container, then run `docker compose run --rm --no-deps cap node src/restore.js /app/backups/cap-YYYYMMDDTHHMMSSZ.sqlite --force`, and start the service again with `docker compose up -d`. The backup volume remains mounted in the one-off container. Keep a separate off-host copy; a backup stored on the same host is not disaster recovery.

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
- JWT login, authenticated password changes, and administrator provisioning for institutional roles.
- Per-user token-version enforcement: password changes revoke all previously issued sessions and return a replacement token for the current session.
- Draft -> pending review -> approved -> internal publication workflow with independent creator/reviewer/publisher separation.
- CAP 1.2 XML export with numeric-offset timestamps, multiple language blocks, multiple categories/response types, multiple affected areas, geocodes, altitude/ceiling, parameters and supplemental resources.
- Dashboard advanced JSON editor for multilingual information blocks and supplemental resources.
- Dashboard actions and API support for linked Update and Cancel drafts; derived messages remain in Test status pending independent review.
- Administrator account activation/deactivation with safeguards against disabling the current administrator or the last active administrator.
- GitHub Actions downloads the official OASIS CAP 1.2 XSD and validates a generated multilingual XML example with xmllint.
- Public JSON feed for published Public-scope `Actual` alerts, including multilingual `info_blocks`, geometry, references, and CAP metadata.
- Public JSON and GeoJSON feeds automatically exclude alerts whose CAP `expires` timestamp has passed; alerts without an expiry remain available until administratively superseded or cancelled.
- Public GeoJSON feed for published Public-scope `Actual` alerts; CAP polygons are converted to GeoJSON longitude-latitude coordinate order and CAP circles are represented as points with `radius_km` metadata.
- Interactive Leaflet map for published public alerts, severity-aware symbols, circle-radius rendering, local GeoJSON preview/import, and public GeoJSON download. Imported files are preview-only and are not persisted.
- Basic audit trail.
- Basic validation of required CAP fields, enumerations, date ordering, closed polygons, and circle geometry.
- CAP `status` is restricted to the four CAP 1.2 values (`Actual`, `Exercise`, `System`, `Test`); `draft`, `pending`, `approved`, and `published` are internal workflow states and are never emitted as CAP status values.
- GitHub Actions runs Node 24 syntax checks, automated tests, official CAP 1.2 XSD validation, npm audit reporting, Docker image build and container health smoke test.
- Scheduled CodeQL static analysis and Dependabot dependency updates.
- Automated Node.js tests for identifiers, CAP validation, geometry, dates, XML export, audit immutability, API role separation, linked Update/Cancel references, public feed filtering and GeoJSON output.

## API

- `GET /api/health`
- `POST /api/auth/login`
- `GET /api/me`
- `POST /api/auth/change-password`
- `GET /api/users` (admin only)
- `POST /api/users` (admin only; provisions admin/forecaster/reviewer/approver/publisher/viewer accounts)
- `PATCH /api/users/:id/status` (admin only; activates/deactivates an account with last-admin safeguards)
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
- `GET /api/audit`

## Important safety and deployment notes

This repository is an initial development foundation, not a certified or production-ready public warning service. Publishing currently exposes approved alerts through the public JSON endpoint only when their CAP status is `Actual` and scope is `Public`; Test and Exercise messages are excluded. No external CAP distribution, email, SMS, push, or government alert gateway is configured. The dashboard includes an administrator-only account provisioning panel and an advanced JSON editor for multilingual CAP info blocks. MFA and administrator password-reset workflows are still pending; account activation/deactivation is available with last-administrator safeguards.

Before operational use, expand the existing official CAP 1.2 XSD check into a complete conformance suite across all CAP message types, profiles, signatures, edge cases, and institutional interoperability scenarios, complete account lifecycle controls (including MFA and secure password recovery), HTTPS, backups, monitoring, security testing, and institution-specific authorization and approval procedures. Keep deployments private until these controls are completed. Use Test/Exercise messages during development, and configure unique non-placeholder `JWT_SECRET` and `ADMIN_PASSWORD` values before startup.

## Roadmap

See [docs-architecture.md](docs-architecture.md) for the staged delivery plan.
