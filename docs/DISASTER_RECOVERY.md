# Disaster Recovery (test deployments)

1. Identify latest verified backup (`npm run backup:list` / `backup:health`).
2. Restore to a **separate** database path and run integrity checks.
3. Validate CAP references and workflow counts against expectations.
4. Only after verification, point `DB_PATH` at the restored file.
5. Restart API process and confirm `/api/health/ready`.

Audit log is append-only with hash chaining; local deletion is not a recovery tool. Off-host archival is institutional.
