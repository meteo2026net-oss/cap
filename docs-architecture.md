# Architecture and delivery roadmap

## Chosen architecture
- Standalone Node.js 20+ service.
- Express REST API.
- SQLite for the first portable deployment; PostgreSQL adapter planned for multi-instance deployments.
- CAP 1.2 XML generation.
- Browser dashboard with Arabic RTL.
- Public read-only JSON feed plus authenticated management API.

## Delivery phases
1. Foundation: app shell, database, authentication, roles, draft/review/approval/publish, XML export.
2. CAP completeness: XSD validation, full CAP element coverage, references, resources, geocodes, multilingual info blocks, update/cancel chains.
3. Geospatial: Leaflet map, polygon/circle drawing, GeoJSON import/export, administrative boundaries.
4. Governance: user administration, MFA, password reset, immutable audit events, approval policies, tenant/institution profiles.
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
