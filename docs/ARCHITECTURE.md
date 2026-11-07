# Architecture

## Purpose
Local CAP 1.2 warning management platform for draft → review → approve → internal publish workflows. External delivery adapters remain disabled.

## Components
| Component | Responsibility |
|-----------|----------------|
| `src/server.js` | HTTP API, authz, workflow transitions, metrics/retention endpoints |
| `src/cap.js` | CAP validation, XML build/parse, semantic rules |
| `src/db.js` | SQLite schema, migrations, admin bootstrap |
| `src/delivery.js` | Internal outbox enqueue/claim/retry (no external send) |
| `src/delivery-worker.js` | Optional maintenance worker for queue only |
| `src/audit.js` | Append-only hash-chained audit log |
| `src/mfa.js` | TOTP/recovery secrets |
| `src/retention.js` | Local terminal-row retention; never deletes audit |
| `src/backup-utils.js` | Backup, restore, verification helpers |
| `tools/cap-receivers/` | Independent local CAP receivers for interop tests |
| `tests/` | Unit, integration, schema, security, performance |

## Data flow
1. Forecaster creates draft alert.
2. Submit → reviewer/approver → publisher.
3. Publish validates CAP XML, marks published, enqueues internal outbox.
4. Public feeds expose only Public + Actual non-expired messages.
5. Update/Cancel/Ack/Error derive from published sources with CAP references.

## Single points of failure (test deployments)
- Single SQLite file (mitigate with backups + restore drills).
- Single Node process (mitigate with process supervisor in institutional hosting).
- In-memory process loss does not lose committed SQLite transactions.
