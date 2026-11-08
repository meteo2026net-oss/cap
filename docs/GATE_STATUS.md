# Project Gate Status

**Branch:** `fix/retention-audit-atomicity`  
**Current head (this document):** `53ee894ba0894bb92017c95f238d0af2290f2b4c`  
**PR #4:** open, **Draft**, not merged  
**CI on this head:** CAP system checks **success** · CodeQL **success**  
**external_adapters_enabled:** **false**

## Legend (strict)

| Label | Meaning |
|-------|---------|
| **Software-tested** | Automated or documented technical evidence exists in this repository / CI. Does **not** mean institutional approval. |
| **Partial** | Software present or partially tested; policy, environment, or operator evidence still required. |
| **Open** | Not claimed. Must not be marked done from CI, docs alone, or PR merge. |

Green CI and repository documentation **never** close Gate 8.

---

## Gate 1 — Stabilize current revision

| Item | Classification | Notes |
|------|----------------|-------|
| Pin SHA + review commits | Software-tested | `docs/PHASE1_BASELINE.md`; head above |
| Review PR #4 changes | Software-tested | Draft only; no merge without explicit approval |
| Admin audit / webhook pagination / org isolation / schema / full suite | Software-tested | CAP system checks + CodeQL success on current head |

---

## Gates 2–7 — Technical capability (not go-live)

| Gate | Classification | Bound |
|------|----------------|-------|
| 2 CAP + alert lifecycle | Software-tested | XSD, lifecycle tests; not receiver certification |
| 3 Auth, MFA, roles, IDOR tests | Software-tested | Restricted/Private recipient **model** remains Partial; Public-only API boundary still enforced for non-Public rows |
| 4 Maps + org-bound webhooks | Software-tested | Ingress off unless explicitly enabled; inbox is manual review |
| 5 Internal outbox / workers | Software-tested | External email/SMS/webhook transport **Open by policy** |
| 6 Retention atomicity, backup tooling, CI perf harness | Software-tested | Off-host backup schedule + signed restore drill **Open** (institutional) |
| 7 Health/metrics + repo runbooks | Software-tested | Staging/prod/HTTPS institutional setup **Open** |

---

## Gate 8 — Institutional acceptance (OPEN — no Go-Live)

Gate 8 is **not** a software task. It closes only when the owning institution supplies **named evidence and signatures**. Repository files, CI success, and PR state are insufficient.

| Evidence item | Owning party | Status |
|---------------|--------------|--------|
| Named warning authority + accountable service owner | Owning institution | **Open** |
| Role / approval / MFA / break-glass policy | Security & governance | **Open** |
| Restricted/Private recipient model approval | Identity & beneficiary owners | **Open** — do not re-enable non-Public workflows without this |
| Production secrets + HTTPS | Infrastructure owner | **Open** |
| Off-host encrypted backups + signed restore report | Operations owner | **Open** |
| Independent security review report | Independent security party | **Open** |
| External receiver interoperability results | Receiving-system owners | **Open** |
| Explicit decision: keep adapters off **or** enable after acceptance | Service owner + authorized body | **Open** — adapters remain **disabled** in code |
| Isolated two-tenant operational drill report | Ops + test team | **Open** |
| Final institutional sign-off | Authorized owning body | **Open** |

Full register template: [`docs/INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md`](INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md)

### Gate 8 non-claims (binding)

- No approval to issue **Actual** public warnings  
- No enablement of external email / SMS / outbound webhook / government-gateway adapters  
- No re-opening of Restricted/Private beyond the current Public-only API safety boundary  
- No merge of PR #4 to Ready/main without explicit human approval  
- No CAP certification or institutional acceptance claim  

**Institutional completion of Gate 8: not evidenced. Do not derive a project-wide completion percentage from CI alone.**

---

## Rule compliance (current head)

- PR #4 remains Draft  
- Security tests are not weakened to obtain green CI  
- `external_adapters_enabled: false`  
- No production-readiness or go-live claim  
