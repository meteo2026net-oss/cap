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
4. Governance: basic administrator user provisioning and password change are implemented; remaining work includes MFA, password reset/recovery, account deactivation, tamper-evident audit events, configurable approval policies, and tenant/institution profiles.
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
- The workflow prevents a creator from approving their own alert and prevents the approver from publishing that same alert.
- Geographic area validation currently supports a closed CAP polygon or one CAP circle. Interactive map drawing and official XSD validation are not yet implemented.
- Automated tests and a GitHub Actions workflow have been added, but their successful execution has not yet been confirmed in this delivery environment.
- This remains a development foundation. Do not use it as an operational public-warning authority until formal CAP conformance, security, institutional, and end-to-end distribution testing are complete.
