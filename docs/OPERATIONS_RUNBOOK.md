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
1. Check readiness and metrics (outbox failed/dead-letter counts).
2. Preserve SQLite file and latest backups.
3. Restore into an isolated path before replacing active DB.
4. Review audit chain verification for privileged actions.
