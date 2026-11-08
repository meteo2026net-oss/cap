# Phase 1 Baseline — Current Version Integrity

**Gate:** Stabilize the current revision before adding new functions.  
**Reference branch:** `fix/retention-audit-atomicity`  
**Reference SHA (Phase 1 close-out):** `b991d5c411b81a6fe18bc9112c91f7206b809f08`  
**Superseding branch heads:** software CI `53ee894ba0894bb92017c95f238d0af2290f2b4c`; docs/register alignment `5d928d955910d29a4936f765704f1c67df7126eb`  
**Gate 8 register:** [`INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md`](INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md) (Open — not closed by Phase 1)  
**PR:** [#4](https://github.com/meteo2026net-oss/cap/pull/4) — **Draft**, not merged  
**Base (main):** `f9b0f1fe8eca2d73070a8870eb325586090b9f7d`  
**CI on reference SHA:** CAP system checks **success**, CodeQL **success**

## Closure checklist

| # | Required work | Evidence | Status |
|---|---------------|----------|--------|
| 1 | Pin latest SHA and review commits | This document; `git log` on branch; 311 commits vs base | **Closed** |
| 2 | Review all PR #4 changes | Diff vs base: `src/webhook-sources.js`, `recipient-auth.js`, retention atomicity, receivers, isolation tests — no unexplained third-party or delivery-enablement changes | **Closed** |
| 3 | Admin audit / sign-in history assertions | `tests/api.integration.test.js`: admin token for null-`alert_id` auth/account events under org-aware `auditReadPredicate`; accepts `login_succeeded` / MFA challenge / MFA success | **Closed** (CI green; verification not weakened) |
| 4 | Webhook inbox pagination | Inserts include `organization_id` + `source_key` for `integration-org`; page size 100 + cursor | **Closed** |
| 5 | Organization isolation / IDOR | `tests/cap-scope-isolation.integration.test.js`, recipient grant enforcement tests | **Closed** in automated suite |
| 6 | SQLite schema create/migrate | `ensureWebhookSourcesSchema`, inbox column guards, org tables via `recipient-auth` | **Closed** |
| 7 | Full test suite | CAP system checks success on `b991d5c` and `28fee08` / `1b009b2` | **Closed** |

## Explicit non-regressions retained

- `external_adapters_enabled: false` on health and delivery responses
- Webhook ingress off unless `CAP_WEBHOOK_INGRESS_ENABLED=true`
- No merge of PR #4 without explicit human approval
- Audit hash-chain and retention atomicity tests remain enabled

## Residual notes (not phase-1 blockers)

- Local `main` tracking may lag `origin/main`; development continues on the PR branch
- Institutional go-live gates remain open (`docs/OPERATIONAL_ACCEPTANCE.md`)
