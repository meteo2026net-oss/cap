# Architecture and delivery roadmap

## Chosen architecture
- Standalone Node.js 20+ service.
- Express REST API.
- SQLite for the first portable deployment; PostgreSQL adapter planned for multi-instance deployments.
- CAP 1.2 XML generation.
- Browser dashboard with Arabic RTL.
- Public read-only JSON feed plus authenticated management API.

## Delivery phases
1. Foundation (partially implemented): app shell, SQLite database, JWT authentication, role provisioning, draft/review/approval/publish, XML export, basic tests and CI workflow. Remaining: migrations, robust session controls, and production hardening.
2. CAP completeness: XSD validation, full CAP element coverage, references, resources, geocodes, multilingual info blocks, update/cancel chains.
3. Geospatial: Leaflet map, polygon/circle drawing, GeoJSON import/export, administrative boundaries.
4. Governance: administrator user provisioning, password change, and guarded account activation/deactivation are implemented; remaining work includes MFA, password reset/recovery, cryptographic tamper-evidence for audit events, configurable approval policies, and tenant/institution profiles. SQLite triggers now reject UPDATE and DELETE operations on audit records (application-level append-only protection, not a cryptographic integrity guarantee).
5. Distribution: configurable CAP feed, HTTPS webhooks, email/SMS/push adapters, retry queue, delivery receipts.
6. Integrations: embeddable public warning widget, API keys, webhooks, SDK examples, CORS allowlists.
7. Operations: PostgreSQL, migrations, backups, monitoring, Docker, deployment profiles, automated tests and security review.

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
- Automated tests cover CAP validation/XML, official CAP 1.2 XSD validation, and GeoJSON conversion. The latest observed GitHub Actions run completed successfully; syntax checks for server, browser, and test scripts are now included in CI.
- This remains a development foundation. Do not use it as an operational public-warning authority until formal CAP conformance, security, institutional, and end-to-end distribution testing are complete.
