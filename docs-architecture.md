# Architecture and delivery roadmap

## Chosen architecture
- Standalone Node.js 20+ service (CI and Docker runtime use Node.js 22).
- Express REST API.
- SQLite for the first portable deployment; PostgreSQL adapter planned for multi-instance deployments.
- CAP 1.2 XML generation.
- Browser dashboard with Arabic RTL.
- Public read-only JSON feed plus authenticated management API.

## Delivery phases
1. Foundation (partially implemented): app shell, SQLite database, JWT authentication, role provisioning, draft/review/approval/publish, XML export, basic tests and CI workflow. Remaining: PostgreSQL support for multi-instance deployments and production hardening.
2. CAP completeness: XSD validation, full CAP element coverage, references, resources, geocodes, multilingual info blocks, update/cancel chains.
3. Geospatial: Leaflet map, polygon/circle drawing, GeoJSON import/export, administrative boundaries.
4. Governance: administrator user provisioning, password change, per-user token-version session revocation, guarded account activation/deactivation, append-only audit triggers, and SHA-256 chained audit entries with an authenticated verification endpoint are implemented. Historical pre-migration audit rows remain unchanged and are identified as unhashed. Database triggers also enforce CAP 1.2 status values independently of API validation. Remaining: MFA, password reset/recovery, externally anchored signed audit checkpoints, configurable approval policies, and tenant/institution profiles. The local SHA-256 chain detects changes within the retained chain but cannot prove that the entire database or complete chain was not replaced or deleted by an attacker with database-level control. API requests are rate-limited globally, with a stricter login limit.
5. Distribution: internal transactional CAP feed outbox, idempotent enqueue, controlled claim/receipt/retry endpoints, and audit events are implemented. The optional maintenance worker, exponential backoff, maximum-attempt handling, dead-letter retention, lease-token receipt binding, and provider-neutral HMAC helper are implemented. External HTTPS webhook, email/SMS/push adapters, replay-cache enforcement, and provider interoperability tests remain pending. No outbound transport is enabled.
6. Integrations: embeddable public warning widget, API keys, webhooks, SDK examples, CORS allowlists.
7. Operations: a non-root Node 22 Docker image, localhost-bound Docker Compose deployment, persistent SQLite and backup volumes, environment template, health check, verified SQLite backup/restore commands and backup retention are implemented. Remaining: PostgreSQL, scheduled off-host backups, monitoring/alerting, deployment profiles and external security review.

## CAP workflow policy
- Drafts are never publicly visible.
- Submission changes a draft to pending.
- A reviewer/approver must approve it.
- A publisher/admin must publish it.
- Update and Cancel messages must reference the prior CAP message using CAP `references`; they must not silently overwrite historical messages.
- Operational alerts must be issued only by authorized institutional personnel under approved procedures.

## Current implementation boundaries
- The current public JSON feed includes only published alerts with CAP status `Actual` and scope `Public`; Test and Exercise messages are excluded.
- The workflow prevents a creator from approving their own alert and prevents the approver from publishing that same alert. Administrators can activate/deactivate accounts, but cannot deactivate their own account or the last active administrator.
- Geographic area validation supports closed polygons, circles, geocodes, multiple areas, altitude and ceiling. Leaflet displays public published alert geometry, supports drawing/editing/deleting one polygon or circle at a time, transfers its CAP geometry into the draft form, and exports the public GeoJSON feed. Local GeoJSON preview enforces a 5 MB file limit, 5,000-feature limit, supported geometry types, coordinate ranges, closed polygon rings and a 100,000-position ceiling; imported properties are allowlisted and clipped before display. Import remains local-only and is not persisted to the server. Administrative boundary selection remains pending.
- XML generation supports multiple language-specific info blocks, multiple categories/response types, resources, parameters and alert references. Update/Cancel drafts reference the prior sender/identifier/sent triple and remain CAP status Test.
- GitHub Actions downloads the official OASIS CAP 1.2 XSD and runs xmllint against a multilingual sample; the result must be checked in the Actions run before treating it as passed.
- Automated tests cover CAP validation/XML, official CAP 1.2 XSD validation, GeoJSON conversion, audit immutability and end-to-end API role/workflow/public-feed behavior. GitHub Actions validates JavaScript syntax, runs the automated test suite and official CAP 1.2 schema checks, builds the production Docker image, and performs a container smoke test; CodeQL runs separately for security analysis.
- This remains a development foundation. Do not use it as an operational public-warning authority until formal CAP conformance, security, institutional, and end-to-end distribution testing are complete.


## Delivery operations and security helpers
- The Arabic operations dashboard exposes the protected internal outbox to administrators and publishers. The API returns database-wide counts for queued, sending, failed, delivered, and dead-letter states independently of the 500 most-recent delivery rows shown in the dashboard. The dead-letter filter is available through `GET /api/delivery/outbox?status=dead_letter`.
- Retry scheduling uses exponential delays beginning at 30 seconds and capped at one hour. Each job has a maximum-attempt count (default 5, permitted range 1–20); exhausted jobs are retained with a `dead_letter_at` timestamp and excluded from automatic retry.
- Each successful claim creates a cryptographically random lease token; receipt updates must present that exact token, so a late response from a recovered/expired worker cannot overwrite a newer claim. Lease tokens are cleared when a claim ends or is recovered. The optional `src/delivery-worker.js` process recovers stale sending leases and processes due retries. Stale leases below their attempt limit return to the queue; leases at the limit are transitioned to dead-letter and audited as a distinct event. It does not claim jobs, open network connections, or transmit alerts.
- `src/webhook-signature.js` provides HMAC-SHA256 signing and verification for timestamped raw webhook bodies, with constant-time signature comparison and a bounded replay window. It is a cryptographic helper only: no webhook sender, receiver, secret storage, or external adapter is enabled.
- Both direct Node.js and Docker Compose installations support the optional maintenance worker. Docker uses the shared persistent SQLite volume; direct mode uses the local `storage/cap.sqlite` file.
