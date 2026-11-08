# CAP 1.2 Technical Conformance Report (Repository Evidence)

**Scope:** Automated and repository-local technical evidence only.  
**Not:** OASIS certification, receiver certification, or Gate 8 institutional acceptance.

**Branch:** `fix/retention-audit-atomicity` (PR #4 Draft)  
**Last confirmed green CAP system checks + CodeQL (lineage):** `26e7cf45889cffdb0fd9b3be2c6a750755e235d0`  
**Software verification head (acceptance pack included):** `26e7cf45889cffdb0fd9b3be2c6a750755e235d0`  
**external_adapters_enabled:** false  

## 1. Method

- GitHub Actions **CAP system checks**: Node test suite + OASIS CAP 1.2 XSD validation path.  
- GitHub Actions **CodeQL**.  
- Local unit/integration tests under `tests/`.  
- Independent local receivers under `tools/cap-receivers/` (simulation only).

## 2. Message construction and schema

| Topic | Result | Evidence |
|-------|--------|----------|
| Alert / Update / Cancel / Ack / Error | Covered | `tests/cap-schema.test.js`, `tests/cap.test.js`, `tests/cap-semantic.test.js` |
| OASIS XSD positive + negative | Covered in CI when green | `tests/cap-schema.test.js` |
| References triplets | Covered | semantic + schema tests |
| Public / Restricted / Private fields | Validated; operational non-Public denied | isolation + API tests |
| Languages / geometry | Covered at unit level | `tests/cap.test.js` |

## 3. Lifecycle and authorization (technical)

| Topic | Result | Evidence |
|-------|--------|----------|
| Draft → submit → approve → publish | Covered | API / lifecycle integration |
| Update / Cancel derive | Covered | lifecycle tests |
| Role separation | Covered | API integration |
| IDOR / tenant isolation | Covered + acceptance pack test | scope isolation, recipient-auth, `acceptance-two-tenant` |
| Org-bound webhooks, replay | Covered when ingress test-enabled | API + acceptance pack |
| Public feed Actual-only | Covered | API / public feed tests |

## 4. Explicit non-coverage

- Interoperability with named external institutional receivers  
- Legal authority to issue Actual public warnings  
- Production secrets, HTTPS topology, off-host backup sign-off  
- Enabling external delivery adapters  

## 5. Phase 3 transition criteria

| Criterion | Status |
|-----------|--------|
| Automated suite green on a documented head | **Yes:** `26e7cf45889c` (CAP + CodeQL success; acceptance-two-tenant included) |
| Acceptance isolation asserts retained (not weakened) | Yes — tightened in `6ade817` |
| Operator isolated pack executed and logged | **Pending** host run (`ISOLATED_ACCEPTANCE_TEST_PACK.md`) |
| This technical report filed | **Yes** (this document) |
| Gate 8 institutional rows | **All Open** |

## 6. Conclusion

Repository technical CAP 1.2 coverage is implemented and previously verified green on `179fa1f`. Acceptance two-tenant automation was added and corrected for startup constraints without relaxing isolation or publish assertions. Institutional acceptance remains out of scope for this report.
