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

Open http://localhost:8095.

## Current starter features

- Arabic RTL dashboard.
- SQLite schema and initial administrator bootstrap.
- JWT login, authenticated password changes, and administrator provisioning for institutional roles.
- Draft -> pending review -> approved -> internal publication workflow with independent creator/reviewer/publisher separation.
- CAP 1.2 XML export with numeric-offset timestamps, multiple language blocks, multiple categories/response types, multiple affected areas, geocodes, altitude/ceiling, parameters and supplemental resources.
- Dashboard advanced JSON editor for multilingual information blocks and supplemental resources.
- Dashboard actions and API support for linked Update and Cancel drafts; derived messages remain in Test status pending independent review.
- Administrator account activation/deactivation with safeguards against disabling the current administrator or the last active administrator.
- GitHub Actions downloads the official OASIS CAP 1.2 XSD and validates a generated multilingual XML example with xmllint.
- Public JSON feed for published Public-scope `Actual` alerts, including multilingual `info_blocks`, geometry, references, and CAP metadata.
- Basic audit trail.
- Basic validation of required CAP fields, enumerations, date ordering, closed polygons, and circle geometry.
- GitHub Actions workflow runs the automated test suite on pushes and pull requests.
- Automated Node.js test suite for identifiers, CAP validation, geometry, dates, and XML export.

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
- `GET /api/audit`

## Important safety and deployment notes

This repository is an initial development foundation, not a certified or production-ready public warning service. Publishing currently exposes approved alerts through the public JSON endpoint only when their CAP status is `Actual` and scope is `Public`; Test and Exercise messages are excluded. No external CAP distribution, email, SMS, push, or government alert gateway is configured. The dashboard includes an administrator-only account provisioning panel and an advanced JSON editor for multilingual CAP info blocks. MFA and administrator password-reset workflows are still pending; account activation/deactivation is available with last-administrator safeguards.

Before operational use, implement and test official CAP 1.2 XSD validation, a complete conformance suite across all CAP message types, profiles, signatures, edge cases, and institutional interoperability scenarios, complete account lifecycle controls (including MFA and secure password recovery), HTTPS, backups, monitoring, security testing, and institution-specific authorization and approval procedures. Keep deployments private until these controls are completed. Use Test/Exercise messages during development, and configure unique non-placeholder `JWT_SECRET` and `ADMIN_PASSWORD` values before startup.

## Roadmap

See [docs-architecture.md](docs-architecture.md) for the staged delivery plan.
