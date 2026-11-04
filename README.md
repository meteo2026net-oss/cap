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
- JWT login and role-guarded endpoints.
- Draft -> pending review -> approved -> internal publication workflow.
- CAP XML export for saved alerts.
- Public JSON feed for published Public-scope alerts.
- Basic audit trail.
- Basic validation of required fields, CAP enumerations, date ordering, closed polygons, and circle geometry.
- Automated Node.js test suite for identifiers, CAP validation, geometry, dates, and XML export.

## API

- `GET /api/health`
- `POST /api/auth/login`
- `GET /api/me`
- `GET /api/alerts`
- `GET /api/alerts/:id`
- `POST /api/alerts`
- `POST /api/alerts/:id/submit`
- `POST /api/alerts/:id/approve`
- `POST /api/alerts/:id/publish`
- `GET /api/alerts/:id/cap.xml`
- `GET /api/public/alerts`
- `GET /api/audit`

## Important safety and deployment notes

This repository is an initial development foundation, not a certified or production-ready public warning service. Publishing currently exposes approved alerts only through the internal public JSON endpoint. No external CAP distribution, email, SMS, push, or government alert gateway is configured.

Before operational use, implement and test official CAP 1.2 XSD validation, full CAP element coverage (including multilingual Info blocks, Resources, Geocodes, References, and Update/Cancel chains), account administration and MFA, HTTPS, backups, monitoring, security testing, and institution-specific authorization and approval procedures. Keep deployments private until these controls are completed. Use Test/Exercise messages during development.

## Roadmap

See [docs-architecture.md](docs-architecture.md) for the staged delivery plan.
