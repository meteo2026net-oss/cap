# Project Gate Status

**Branch:** `fix/retention-audit-atomicity`  
**Documentation head:** `5d928d955910d29a4936f765704f1c67df7126eb`  
**Last head with CAP system checks + CodeQL success (software verification):** `53ee894ba0894bb92017c95f238d0af2290f2b4c`  
**PR #4:** open, **Draft**, not merged — https://github.com/meteo2026net-oss/cap/pull/4  
**external_adapters_enabled:** **false**

**Canonical institutional acceptance register (Gate 8 only):**  
[`docs/INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md`](INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md)  
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
| Full suite on software verification head | Software-tested | CAP system checks + CodeQL success on `53ee894ba0894bb92017c95f238d0af2290f2b4c` |

---

## Gates 2–7 — Technical capability (not go-live)

| Gate | Classification | Bound |
|------|----------------|-------|
| 2 CAP + alert lifecycle | Software-tested | XSD and lifecycle tests; not receiver certification |
| 3 Auth, MFA, roles, IDOR tests | Software-tested | Restricted/Private recipient **authorization for operations** remains Open/Partial; Public-only API boundary still enforced for non-Public rows |
| 4 Maps + org-bound webhooks | Software-tested | Ingress off unless explicitly enabled; inbox is manual review |
| 5 Internal outbox / workers | Software-tested | External transport **Open by policy** |
| 6 Retention atomicity, backup tooling, CI perf harness | Software-tested | Off-host backup + signed restore drill tracked only in the institutional register |
| 7 Health/metrics + repo runbooks | Software-tested | Staging/prod/HTTPS institutional setup tracked only in the institutional register |

---

## Gate 8 — Institutional acceptance (OPEN — no Go-Live)

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
