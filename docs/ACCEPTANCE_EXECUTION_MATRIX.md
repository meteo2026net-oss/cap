# Acceptance Execution Matrix (Phases 3–5)

Maps the full acceptance checklist to **what the repository can prove**, **what operators run**, and **what only the institution can close**.

**PR #4:** Draft · **Adapters:** disabled · **Gate 8 register:** [INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md](INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md) (all Open)

**Software CI reference head:** `179fa1f14c19f076512fc8c7be23288f4120727a` (CAP system checks + CodeQL success)  
**Pack head (includes this matrix lineage):** branch tip on `fix/retention-audit-atomicity`

---

## Phase 1 — Documentation (engineering)

| Step | Result |
|------|--------|
| 1–5 Unify refs, Gate 8 register, 14 rows Open | **Done** in repo docs |

---

## Phase 2 — Isolated setup (engineering + local ops)

| Step | Artifact | Result |
|------|----------|--------|
| 6 Acceptance plan | [ISOLATED_ACCEPTANCE_TEST_PACK.md](ISOLATED_ACCEPTANCE_TEST_PACK.md) | **Done** |
| 7 Two orgs | `accept-org-a` / `accept-org-b` | Defined in pack |
| 8 Accounts/roles | Pack section 3 | Defined in pack |
| 9 Webhook/receivers | Org sources + `tools/cap-receivers` | Defined; no external send |
| 10 Pass/fail criteria | Pack section 6 | **Done** |

---

## Phase 3 — Technical tests

| Step | Automated evidence (repo/CI) | Operator (isolated host) | Engineering close? |
|------|------------------------------|--------------------------|--------------------|
| **11 Isolation / IDOR** | `tests/cap-scope-isolation.integration.test.js`, `tests/recipient-auth.integration.test.js`, `tests/recipient-grant-enforcement.integration.test.js`, `tests/acceptance-two-tenant.integration.test.js` | Pack scenarios I1–I3 | **Yes if CI + operator I1–I2 PASS** |
| **12 Alert lifecycle** | `tests/cap-lifecycle.integration.test.js`, `tests/api.integration.test.js`, interop lifecycle | Pack L1–L4 on Org A | **Yes if CI + L1–L4 PASS** |
| **13 Roles / sessions** | API integration (deactivate, 403 matrix, MFA), `login_failed` audit | Pack R1–R3 | **Yes if CI + R1–R2 PASS** |
| **14 Webhook / outbox / workers** | webhook tests, `tests/delivery.test.js`, retention atomicity, worker internal-only | Pack W1–W3; confirm health `external_adapters_enabled:false` | **Yes if CI + W1–W3 PASS** |
| **15 Restricted / Private** | Public-only boundary tests; no operational enablement | Confirm non-Public not on public feed; **do not** treat as accepted recipient model | **Boundary tested; operational acceptance = Gate 8 row 4 only** |
| **16 CAP 1.2 report** | `tests/cap-schema.test.js`, `cap.test.js`, `cap-semantic.test.js`, phase7 receivers | Attach CI URL / `npm test` log to technical evidence folder | **Technical report yes; not CAP certification** |

### Phase 3 command (isolated host)

```bash
git checkout fix/retention-audit-atomicity
git pull
npm ci
npm test
# optional: npm run perf:10k
curl -s http://127.0.0.1:8095/api/health   # after npm start
```

Record the git SHA and CI/run logs. **Do not** write Accepted into the institutional register from these results.

---

## Phase 4 — Institutional evidence (external parties)

| Step | Register row | Engineering can do | Institution must supply |
|------|--------------|--------------------|-------------------------|
| 17 Owner / authority | 1 | — | Named authority + service owner |
| 18 Geo/language/severity policy | 2 | — | Approved policy artifact |
| 19 Identity/roles/MFA/SoD | 3 | Software supports MFA/roles | Approved policy |
| 20 Org/recipient/grant model | 4 | Partial software model + Public-only safety | Formal model acceptance |
| 21 Secrets/infra/HTTPS | 5–6 | `.env.example`, docs | Production controls evidence |
| 22 Off-host backup + restore | 7–8 | `npm run backup` / restore tooling | Off-host store + **signed** drill |
| 23 Independent security review | 9 | CodeQL in CI (not a substitute) | Independent report + disposition |
| 24 External receivers + channel decision | 10–11 | Local receivers only | External accept/reject + adapter decision |
| 25 Acceptance drill report | 12–13 | Pack execution support | Drill report + legal/comms as required |

**Phase 4 status in repository:** templates only · **all rows Open**

---

## Phase 5 — Closure

| Step | Action | Status |
|------|--------|--------|
| 26 Audit register completeness | Every row Evidence ID + Date + Approver or still Open | **Open** |
| 27 Go-Live decision document | Institution-owned | **Open** |
| 28 Formal signature (row 14) | Owning body only | **Open** |

Until step 28, project state remains: **software-complete / not institutionally accepted / no Go-Live**.

---

## Binding constraints (all phases)

- PR #4 remains Draft until explicit merge approval  
- `external_adapters_enabled: false`  
- No Actual public warning authority from CI or this matrix  
- No Gate 8 row marked Accepted without institutional evidence  
