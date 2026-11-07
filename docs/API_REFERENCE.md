# API Reference (summary)

Base auth: `Authorization: Bearer <jwt>` unless noted.

## Health
- `GET /api/health` — liveness; includes `external_adapters_enabled: false`
- `GET /api/health/ready` — SQLite quick_check + foreign_keys
- `GET /api/health/metrics` — admin/publisher queue/DB metrics

## Auth / users
- `POST /api/auth/login`
- `POST /api/auth/change-password`
- MFA routes under `/api/auth/mfa/*`
- `GET /api/me`, `/api/users` (admin)

## Alerts workflow
- `POST /api/alerts` — create draft (forecaster/admin)
- `PATCH /api/alerts/:id` — edit draft fields only (no references_text)
- `POST /api/alerts/:id/submit|return|approve|publish`
- `POST /api/alerts/:id/derive` — body `{ msg_type: Update|Cancel|Ack|Error }`
- `GET /api/alerts`, `/api/alerts/:id`, `/api/alerts/:id/cap.xml`
- `GET /api/alerts/:id/relations`

## Public feeds (unauthenticated)
- `GET /api/public/alerts`
- `GET /api/public/alerts.geojson`
Only `workflow=published`, `scope=Public`, `status=Actual`, non-expired.

## Operations
- `POST /api/ops/retention/apply` — admin; local terminal retention
- Delivery maintenance under `/api/delivery/*` (publisher/admin); no external transport

## Security notes
Sensitive responses use `Cache-Control: no-store`. Restricted/Private never appear on public feeds.
