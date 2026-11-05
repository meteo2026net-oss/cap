# Security Policy

## Supported branch

Security fixes are applied to the `main` branch.

## Reporting a vulnerability

Please do not publish exploitable vulnerability details in a public issue. Use GitHub's private vulnerability reporting feature for this repository (Security → Advisories → Report a vulnerability), if enabled. Include affected commit, impact, reproduction steps, and a suggested mitigation where possible.

## Deployment requirements

- Never commit `.env`, credentials, JWT secrets, database files, or production warning data.
- Use unique random `JWT_SECRET` and a unique administrator password.
- Keep the service bound to localhost behind a maintained HTTPS reverse proxy; do not expose the application port directly.
- Restrict administrator and publisher accounts to authorized institutional personnel.
- Back up the SQLite database securely and test restoration before upgrades.
- Keep Test/Exercise messages for non-operational validation.
- Do not use this development project as an official public-warning authority until institutional approval, CAP conformance testing, security review, monitoring, and operational procedures are complete.

## Browser security headers

The Express application uses Helmet with a restrictive Content Security Policy:
- Scripts are limited to the application origin and the pinned Leaflet CDN origin currently used by the dashboard.
- Inline HTML event-handler attributes are blocked with script-src-attr 'none'; dashboard actions use JavaScript event listeners and delegated data-* controls.
- object-src is disabled, base-uri is restricted to the application origin, and frame-ancestors is set to none.
- Images permit the application, data/blob URLs used by the UI, the OpenStreetMap tile host, and the Leaflet CDN. Styles still permit inline styles because the current dashboard and Leaflet drawing controls use style attributes.

For a stricter deployment, self-host and pin the Leaflet assets, then remove the CDN origins from the policy. Do not add unsafe-eval or re-enable inline script/event handlers to work around a browser console error. If a reverse proxy is used, preserve the application's security headers and configure HTTPS there; avoid weakening the policy globally.

## Backup and recovery verification

A successful backup command is not a substitute for a restore drill. Before each production-like release:
1. Take a fresh backup and copy it to a separately controlled storage location.
2. Restore it into an isolated test environment, never over the live database during the drill.
3. Verify database integrity and the audit-chain verification endpoint.
4. Confirm that users, CAP alerts, references, and workflow states are present.
5. Record the tested backup timestamp, restore result, and operator in the institution's change log.

Do not store backup archives in the public web root or commit them to Git.
