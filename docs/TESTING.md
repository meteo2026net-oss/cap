# Testing

## Commands
- `npm test` — full Node test suite
- `npm run test:cap-schema` — OASIS XSD tests when xmllint/schema present
- `npm run perf:10k` — manual 10,000-message benchmark using CAP functions and the application SQLite schema; emits a JSON report

## Layers
- Unit: CAP semantics, MFA, audit, delivery, retention, receivers
- Integration: API workflows, isolation, phases 4–6, lifecycle
- Performance CI smoke: `tests/perf/cap-performance.test.js` (100/1000 synthetic messages)
- Extended performance: `tests/perf/run-10k.mjs` (10,000 synthetic messages; local manual run)

The 10,000-message harness measures validation, XML build/parse, insert into the actual application `alerts` schema, and scoped SQLite reads. Its dataset is synthetic and it is not a production load test.
- Security: role gates, cache headers, scope isolation

CI must pass on the same SHA used for acceptance claims.
