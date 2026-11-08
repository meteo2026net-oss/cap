# Project Gate Status

**Branch:** `fix/retention-audit-atomicity`  
**PR #4 head (current tip):** `6ade8179d8d24d94076bf021a4a93335d4f200a0` (Draft, not merged)
**Last green CAP system checks + CodeQL:** `179fa1f14c19f076512fc8c7be23288f4120727a`
**Verification note:** Confirm CI success on tip before treating it as the software verification head.
**Institutional Gate 8:** **Open** — sole register: [`INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md`](INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md)
**external_adapters_enabled:** **false**

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
| Full suite on PR head | Software-tested | CAP system checks + CodeQL success on `179fa1f14c19f076512fc8c7be23288f4120727a` |

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
