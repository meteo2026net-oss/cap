# Testing

## Commands
- `npm test` — full Node test suite
- `npm run test:cap-schema` — OASIS XSD tests when xmllint/schema present

## Layers
- Unit: CAP semantics, MFA, audit, delivery, retention, receivers
- Integration: API workflows, isolation, phases 4–6, lifecycle
- Performance: `tests/perf/cap-performance.test.js` (100/1000 synthetic messages)
- Security: role gates, cache headers, scope isolation

CI must pass on the same SHA used for acceptance claims.
