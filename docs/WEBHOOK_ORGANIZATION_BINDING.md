# Webhook organization binding

## Baseline
- Branch: `fix/retention-audit-atomicity`
- SHA: `6bbeef60d6314c00b33f7348db30ab91e543acae` (pre-change) then subsequent commits on the same branch
- PR: https://github.com/meteo2026net-oss/cap/pull/4 (Draft)

## Ingress rules
1. Ingress remains disabled unless `CAP_WEBHOOK_INGRESS_ENABLED=true`.
2. Every accepted request requires `X-Webhook-Source` identifying a **registered** source.
3. Source → organization binding is loaded only from `webhook_sources` in SQLite.
4. JSON body fields such as `organization_id` are ignored for authorization.
5. Signature verification uses the per-source secret stored encrypted in the registry.
6. Replay protection remains enforced via `webhook_replay_guard`.
7. Inbox rows store `organization_id`, `webhook_source_id`, and `source_key`.
8. External delivery adapters remain disabled; ingress only queues for **manual review**.

## Admin APIs
- `GET /api/webhook-sources`
- `POST /api/webhook-sources` (returns secret once)
- `POST /api/webhook-sources/:id/disable`
