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

## Request limits and inbound webhook ingress

- JSON API request bodies are limited to **1 MB**. Oversized requests are rejected with HTTP 413.
- `POST /api/webhooks/inbound` accepts raw JSON bodies up to **64 KB** and is limited to **30 requests per minute**.
- Webhook ingress is disabled unless `CAP_WEBHOOK_INGRESS_ENABLED=true`. Enabling it requires a unique `CAP_WEBHOOK_SECRET` of at least 32 bytes.
- Inbound requests require an HMAC-SHA256 signature over the exact timestamp and raw request body. The timestamp tolerance is 300 seconds; a consumed signature is retained by the replay guard for 600 seconds.
- Signature verification, replay consumption, and inbox insertion are performed atomically. Concurrent replays of the same signed request must result in at most one accepted inbox entry.
- Accepted messages enter the inbox as `pending` and require manual review. Ingress does not publish alerts or activate an external delivery adapter.
