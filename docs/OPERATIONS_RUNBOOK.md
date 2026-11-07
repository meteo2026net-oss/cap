# Operations Runbook (test)

## Start / stop
- Start: `npm start`
- Worker (optional): `npm run worker`
- Stop: Ctrl+C (complete in-flight SQLite transactions)

## Health
- Liveness: `GET /api/health`
- Readiness: `GET /api/health/ready`
- Metrics: `GET /api/health/metrics` (admin/publisher token)

## Common actions
- Apply local retention: `npm run retention:apply` (deletion and `retention_applied` audit record are committed in one SQLite transaction; CLI-originated events use a null user ID)
- Backup: `npm run backup`
- Verify backups: `npm run backup:health`

## Incidents
- If retention returns `audit_checkpoint_warning`, the retention transaction and database audit event have committed, but the external checkpoint file was not refreshed. Restore checkpoint write access, then run `npm run audit:checkpoint:refresh` with the original checkpoint path and secret. This command advances only an existing valid HMAC checkpoint whose anchor still exists in a fully verified chain. If the checkpoint is missing, malformed, has an invalid signature, or its anchor is absent, stop and restore trusted off-host checkpoint evidence; do not initialize a replacement over an unknown history.
1. Check readiness and metrics (outbox failed/dead-letter counts).
2. Preserve SQLite file and latest backups.
3. Restore into an isolated path before replacing active DB.
4. Review audit chain verification for privileged actions.
