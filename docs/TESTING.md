# Testing

## Commands
- `npm test` — full Node test suite
- `npm run test:cap-schema` — OASIS XSD tests when xmllint/schema present
- `npm run perf:10k` — 10,000-message benchmark using CAP functions and the application SQLite schema; runs in CI and can also be run locally, emitting a JSON report

## Layers
- Unit: CAP semantics, MFA, audit, delivery, retention, receivers
- XML parser security: CAP 1.2 namespace enforcement (default/prefixed), DTD/entity rejection, and a 1 MB input limit
- Integration: API workflows, isolation, phases 4–6, lifecycle
- Performance CI smoke: `tests/perf/cap-performance.test.js` (100/1000 synthetic messages)
- Extended performance: `tests/perf/run-10k.mjs` (10,000 synthetic messages; automated CI run and local reproducible command)

The 10,000-message harness measures validation, XML build/parse, insert into the actual application `alerts` schema, and scoped SQLite reads. Its dataset is synthetic and it is not a production load test.
- Security: role gates, middleware-wide `MFA_REQUIRED_ROLES` enforcement (including auth-only data routes), cache headers, scope isolation
- Browser asset / DOM security: `tests/static-assets-security.test.js` checks SRI, anonymous CORS, no-referrer attributes, CSP permissions for the Leaflet Draw CDN, HTML escaping of dynamic dashboard templates, and the reviewed HTML insertion points.

CI must pass on the same SHA used for acceptance claims.
