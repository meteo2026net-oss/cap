# Backup and Restore

## Commands
- `npm run backup` — create SQLite backup + checksum
- `npm run backup:health` — newest backup freshness/integrity
- `npm run backup:list` — inventory
- Restore helpers: `src/restore.js`, `src/restore-drill.js`, `src/verify-restored-db.js`

## Verified behaviours in tests
- Backup checksum and SQLite integrity
- Restore to a separate database file
- `quick_check` and `foreign_key_check` after restore
- Isolated restore drill workflow

## Suggested targets (institutional)
- RPO: ≤ 24h for test deployments without continuous replication
- RTO: ≤ 1h for restore-from-backup drills on comparable hardware
Document actual measured times during each drill; do not treat these defaults as SLAs.
