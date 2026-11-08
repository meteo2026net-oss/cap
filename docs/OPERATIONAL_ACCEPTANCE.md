# Operational Acceptance Checklist (Test Environment)

> This document separates **software behaviors already exercised in automated tests** from **institutional go-live decisions** that this repository cannot complete on its own.
> Do not treat a green CI run as authority to issue public warnings.
>
> **PR #4 head (current tip at documentation update):** `cfa124e5d45c2815abe78604b742317333a71687` (Draft, not merged)
> **Software verification on that head:** CAP system checks **success** · CodeQL **success**
> **Institutional Gate 8:** **Open** — sole register: [`INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md`](INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md)
> **external_adapters_enabled:** **false**

## A. Verified in automated tests (local / CI)

| Area | Evidence | Status |
|------|----------|--------|
| CAP 1.2 XML generation and OASIS XSD checks | `tests/cap-schema.test.js`, lifecycle tests | Tested in CI |
| Alert / Update / Cancel / Ack / Error lifecycle | phase 1–5 integration tests | Tested in CI |
| Restricted / Private exclusion from public feeds | isolation + phase 4/5 tests | Software-tested in CI; operational Restricted/Private recipient authorization remains institutional (Gate 8 register row 4 Open) |
| Temporary Public-only internal API boundary | API integration tests seed legacy non-Public rows and exercise list/detail/export/stats/review/audit/relations/delivery paths | Software-tested on current PR head (CI green); not institutional acceptance of Restricted/Private operations |
| Public feed message-type allowlist | public JSON/GeoJSON expose Alert, Update, Cancel only; Ack/Error excluded by API integration regression tests | Tested in CI on head `046c69ea78435721f211aac88cffed602a799916` (run `42420785229`) |
| Role separation (forecaster / reviewer / publisher) | API + phase 4/6 tests | Tested in CI |
| MFA enroll/login/recovery paths | `tests/mfa.test.js`, API integration | Tested in CI |
| Audit hash-chain append and verification | audit tests | Tested in CI |
| Retention + audit atomicity and rollback | `tests/retention-audit-atomicity.test.js`; database rollback on audit failure, post-commit checkpoint warning, checkpoint refresh gated by explicit off-host evidence attestation | Tested in CI; off-host recovery approval remains institutional |
| Internal delivery outbox enqueue / retry | delivery + phase 5/6 tests | Tested in CI (no external send) |
| Inbound webhook ingress and manual-review inbox | HMAC-SHA256 over timestamp/raw body, timestamp tolerance, replay rejection, atomic replay+inbox insert, concurrent replay, 64 KB body limit, rate limit, reviewer role gate, competing review decisions, audit rollback | Tested in CI; ingress remains disabled by default and no external send occurs |
| SQLite backup, restore, quick_check, FK check | backup/restore + phase 4 tests | Tested in CI |
| Operational metrics endpoint | `GET /api/health/metrics` (admin/publisher) | Tested in CI |
| Local retention of terminal outbox/webhook rows | `src/retention.js`, retention tests | Tested in CI |
| Concurrent draft create/submit stress sample | phase 6 integration test | Tested in CI |
| Process restart durability | phase 4 integration test | Tested in CI |

**Current CAP scope boundary:** Until recipient-level grants are implemented, the application now fails closed for Restricted and Private scopes. Authenticated lists, detail/XML/history/relations, exports, statistics, review queues, audit listing/export, and delivery views are restricted to Public data; non-Public direct IDs are concealed as 404. New structurally valid Restricted/Private creation and scope promotion are blocked. Structurally incomplete requests continue to fail CAP validation with HTTP 400 and are not persisted. Global delivery retry/recovery is blocked while non-Public outbox rows exist. Regression tests cover both validation and authorization outcomes; CI evidence for the latest head is pending. Existing non-Public rows remain in storage and must not be treated as available or authorized. This temporary Public-only mode is not a completed recipient authorization system.

## B. Requires institutional acceptance (not claimed by CI)

**Canonical evidence register:** [`INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md`](INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md). Do not mark these items accepted from section A tests or a green workflow run.

**Recipient model remains outstanding:** non-Public rows are currently denied by a temporary Public-only API policy. This prevents accidental disclosure but does not provide recipient-level entitlements. Existing non-Public records remain stored and inaccessible through the normal API; institutional recipient grants, identity mapping, grant/revoke audit, and independent review are still required before Restricted/Private workflows can be re-enabled.


- [ ] Named warning authority and accountable service owner
- [ ] Approved geography, languages, severity policy, and public-feed scope
- [ ] Approved role roster, MFA policy (`MFA_REQUIRED_ROLES`), and break-glass process
- [ ] Production secrets management (JWT, MFA encryption key, admin bootstrap) with rotation procedure
- [ ] Off-host encrypted backup storage, retention, and monitored scheduling
- [ ] Documented RTO/RPO and a signed restore drill report against a production-like backup
- [ ] Independent security review and vulnerability management process
- [ ] Receiver interoperability tests with each external organization (when required)
- [ ] Explicit decision that external adapters may be enabled (still disabled in this repository)
- [ ] Legal/communications approval for Actual public warnings

## C. Monitoring probes recommended for test deployments

1. `GET /api/health` — process up; confirms `external_adapters_enabled: false`
2. `GET /api/health/ready` — SQLite integrity + foreign keys
3. `GET /api/health/metrics` (admin/publisher token) — outbox depth, failed/dead-letter counts, workflow counts
4. `npm run backup` + `npm run backup:health` — newest backup freshness
5. `npm run retention:apply` — optional local cleanup of terminal operational rows (does not delete audit log)

## D. Explicit non-goals of the current test system

- No real CAP/email/SMS/push/government-gateway transmission
- No claim of CAP certification or institutional go-live approval
- No automatic public-warning issuance without human workflow roles
