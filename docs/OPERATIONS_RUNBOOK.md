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
- If retention returns `audit_checkpoint_warning`, the retention transaction and database audit event have committed, but the external checkpoint file was not refreshed. Restore checkpoint write access, compare the existing checkpoint with independently protected off-host evidence, and review all audit records appended since that anchor. Only after that manual approval, run `npm run audit:checkpoint:refresh -- --confirm-offhost-evidence` with the original checkpoint path and secret. The CLI refuses to proceed without this explicit operator attestation; the flag does not replace the independent evidence review. The command advances only an existing valid HMAC checkpoint whose anchor still exists in a fully verified chain. A valid local HMAC alone does not prove that the checkpoint is the latest trusted copy. If the checkpoint is missing, malformed, has an invalid signature, its anchor is absent, or off-host evidence does not match, stop and restore a consistent database/checkpoint pair from verified backups; do not initialize a replacement over an unknown history.
1. Check readiness and metrics (outbox failed/dead-letter counts).
2. Preserve SQLite file and latest backups.
3. Restore into an isolated path before replacing active DB.
4. Review audit chain verification for privileged actions.
