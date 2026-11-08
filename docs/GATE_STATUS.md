# Project Gate Status

> **Windows CI runner follow-up — 2026-11-08 UTC**

- Runner fix commit: `ee3bda3e1ebc57528159a7692c247c5d29eb0986`; subsequent commits in this PR update the status records only.
- The Windows backup job now targets `windows-2022` so `node-gyp` can use the stable Visual Studio 2022 toolchain for `better-sqlite3`.
- The earlier `windows-latest` run failed during dependency installation; backup/restore tests did not run. The runner change must be verified by the live PR checks on the latest branch tip.
- Do not treat predecessor CI success as validation of the latest tip. `external_adapters_enabled: false`; Gate 8 remains Open; no merge or external delivery.

**Branch:** `fix/retention-audit-atomicity`  
**PR #4 head (current tip):** `26e7cf45889cffdb0fd9b3be2c6a750755e235d0` (Draft, not merged)
**Software verification head (CAP system checks + CodeQL success):** `26e7cf45889cffdb0fd9b3be2c6a750755e235d0`
**Verification note:** CAP system checks + CodeQL **success** on `26e7cf45889c` (includes acceptance-two-tenant).
**Institutional Gate 8:** **Open** — sole register: [`INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md`](INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md)
**external_adapters_enabled:** **false**
**Intended scope:** Syrian Arab Republic only — local programme, not global distribution.
**النطاق المقصود:** الجمهورية العربية السورية فقط — برنامج محلي وليس نشراً عالمياً.

**All steps 1–28 (single file):** [`ALL_STEPS.md`](ALL_STEPS.md)  
**Execution matrix (phases 3–5):** [`ACCEPTANCE_EXECUTION_MATRIX.md`](ACCEPTANCE_EXECUTION_MATRIX.md)  
**Isolated two-tenant technical pack:** [`ISOLATED_ACCEPTANCE_TEST_PACK.md`](ISOLATED_ACCEPTANCE_TEST_PACK.md)  
**Software completion record:** [`SOFTWARE_COMPLETION.md`](SOFTWARE_COMPLETION.md)  
**Institutional evidence workbook (forms only):** [`INSTITUTIONAL_EVIDENCE_WORKBOOK.md`](INSTITUTIONAL_EVIDENCE_WORKBOOK.md)  
**Canonical institutional acceptance register (Gate 8 only):**  
[`INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md`](INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md)  
No other document may mark Gate 8 closed. CI, README, and PR state are not acceptance evidence.

## Legend (strict)

| Label | Meaning |
|-------|---------|
| **Software-tested** | Automated or documented technical evidence in this repository / CI. Not institutional approval. |
| **Partial** | Software present or partially tested; policy, environment, or operator evidence still required. |
| **Open** | Not claimed. Must not be marked done from CI, docs alone, or PR merge. |

---

## Gate 1 — Stabilize current revision

| Item | Classification | Notes |
|------|----------------|-------|
| Pin SHA + review commits | Software-tested | Historical close-out in `PHASE1_BASELINE.md`; branch continues |
| PR #4 review posture | Software-tested | Draft only; no merge without explicit approval |
| Full suite on PR head | Software-tested | CAP system checks + CodeQL success on `26e7cf45889cffdb0fd9b3be2c6a750755e235d0` |

---

## Gates 2–7 — Technical capability (not go-live)

| Gate | Classification | Bound |
|------|----------------|-------|
| 2 CAP + alert lifecycle | Software-tested | XSD and lifecycle tests; not receiver certification |
| 3 Auth, MFA, roles, IDOR tests | Software-tested | Restricted/Private **operational** recipient authorization remains Open on Gate 8 row 4; Public-only API boundary still enforced for non-Public rows |
| 4 Maps + org-bound webhooks | Software-tested | Ingress off unless explicitly enabled; inbox is manual review |
| 5 Internal outbox / workers | Software-tested | External transport **Open by policy** |
| 6 Retention atomicity, backup tooling, CI perf harness | Software-tested | Off-host backup + signed restore drill tracked only in the institutional register |
| 7 Health/metrics + repo runbooks | Software-tested | Staging/prod/HTTPS institutional setup tracked only in the institutional register |

---

## Gate 8 — Institutional acceptance (OPEN — no Go-Live)

Phase 5 pack: [`PHASE5_FINAL_CLOSURE.md`](PHASE5_FINAL_CLOSURE.md) — current process decision **NO-GO** until register rows 1–14 are Accepted with real evidence.


Tracked exclusively in [`INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md`](INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md).  
All register rows are **Open** until the owning institution supplies Evidence ID, Date, and Approver.

### Binding non-claims

- No approval to issue **Actual** public warnings  
- No enablement of external delivery adapters  
- No operational re-opening of Restricted/Private without accepted recipient-model evidence  
- No merge of PR #4 without explicit human approval  
- No CAP certification or institutional acceptance claim  

**Do not derive project-wide completion percentage from CI alone.**

---

## Rule compliance

- PR #4 remains Draft  
- Security tests are not weakened to obtain green CI  
- `external_adapters_enabled: false`  
- No production-readiness or go-live claim  
