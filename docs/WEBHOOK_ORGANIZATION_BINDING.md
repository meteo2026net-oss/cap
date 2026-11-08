# Webhook organization binding

## Baseline
- Branch: `fix/retention-audit-atomicity`
- Final verified head on this branch: `28fee082a0a6bbc120e44b5e625f29ec6b61b45c` (CAP system checks + CodeQL success). Progression: `6bbeef6` → org-bound sources → integration alignment → green CI.
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

## Inbox access
- Administrators see the global inbox.
- Reviewers / non-admins see only rows whose `organization_id` matches an **active** membership of the caller.
- Review mutations require the same membership (or admin).
- Rows without `organization_id` (legacy test inserts) are invisible to non-admins.

## Explicit non-goals
- No external CAP transport, email, SMS, or government-gateway delivery.
- `external_adapters_enabled` remains `false` in health and delivery responses.
- Secrets are encrypted at rest with the same key material used for MFA TOTP secrets; rotate via disable + create.

