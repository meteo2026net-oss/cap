# Isolated Acceptance Test Pack (Two Tenants)

**Purpose:** Operator-run package for technical acceptance in an **isolated** environment.  
**Does not close Gate 8.** Institutional rows stay in [`INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md`](INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md).

**Branch / PR:** `fix/retention-audit-atomicity` · PR #4 Draft  
**Software reference head (CI green at docs alignment):** `cfa124e5d45c2815abe78604b742317333a71687`  
**external_adapters_enabled:** **false** (must remain false for this pack)

---

## Phase status

| Phase | Content | Owner | Status in repo |
|-------|---------|-------|----------------|
| 1 Documentation refs | Unified heads + Open Gate 8 register | Engineering | **Done** (docs) |
| 2 Isolated pack setup | This document | Engineering + local ops | **Ready to execute** |
| 3 Technical tests | Scripts + automated suites below | Engineering / ops | **Partially automated** |
| 4 Institutional evidence | Register rows 1–14 | Institution | **Open** |
| 5 Final sign-off | Register row 14 | Owning body | **Open** |

---

## 1. Environment constraints

1. Dedicated non-production host or disposable VM/container.  
2. No public Actual warning dissemination. Use `status=Test` unless a controlled Actual is explicitly required for a feed check, then delete/expire immediately.  
3. `CAP_WEBHOOK_INGRESS_ENABLED` only if testing inbound webhooks; use org-bound sources only.  
4. Do **not** set any flag that enables external email/SMS/government-gateway adapters.  
5. Capture evidence: timestamp, actor username, request/response summary, DB ids — store outside git if sensitive.

---

## 2. Two experimental organizations

| Org | Suggested slug | Name | Purpose |
|-----|----------------|------|---------|
| **A** | `accept-org-a` | Acceptance Org A | Primary authoring tenant |
| **B** | `accept-org-b` | Acceptance Org B | Cross-tenant isolation peer |

Create via admin API (`POST /api/organizations`) or equivalent admin UI path.

---

## 3. Test identities and roles

Password policy: use strong unique test secrets; never production passwords.

| Username | Role | Org membership | Purpose |
|----------|------|----------------|---------|
| `acc_admin` | admin | (platform) | Bootstrap orgs, memberships, webhook sources |
| `acc_forecaster_a` | forecaster | A active | Draft/submit for A |
| `acc_reviewer_a` | reviewer | A active | Review queue A; inbox A |
| `acc_publisher_a` | publisher | A active | Publish A (MFA if required) |
| `acc_approver_a` | approver | A active | Approve A (MFA if required) |
| `acc_forecaster_b` | forecaster | B active | Draft for B |
| `acc_reviewer_b` | reviewer | B active | Must **not** see A-only inbox/data |
| `acc_viewer_a` | viewer | A active | Read-limited checks |

Activate memberships through the organization membership API (pending → active by admin).

---

## 4. Local webhook / receiver fixtures (isolated)

| Component | How | Notes |
|-----------|-----|--------|
| Org-bound source A | `POST /api/webhook-sources` with `organization_id=A` | Save returned secret once |
| Org-bound source B | Same for B | Separate secret |
| Ingress | Enable only on the isolated host if testing inbound | Still **manual review** inbox; no external send |
| Local CAP receivers | `tools/cap-receivers/` + `tests/cap-phase7-receivers.test.js` | Interop simulation only |

**Success:** Message accepted into A inbox is invisible to `acc_reviewer_b`.  
**Fail:** Cross-tenant inbox read or review.

---

## 5. Technical scenarios (Phase 3 mapping)

### 5.1 Isolation / IDOR

| # | Action | Expect |
|---|--------|--------|
| I1 | B reviewer lists webhook inbox | Empty or B-only rows |
| I2 | B user opens A alert by id (if known) | 403/404 per policy |
| I3 | Automated | `tests/cap-scope-isolation.integration.test.js`, `tests/recipient-auth.integration.test.js` |

### 5.2 Alert lifecycle (prefer Org A, Public, Test)

| # | Step | Expect |
|---|------|--------|
| L1 | Forecaster A creates draft | 201 draft |
| L2 | Submit → reviewer note/return/approve path per roles | Workflow transitions audited |
| L3 | Publisher publishes | Internal outbox only; `external_adapters_enabled: false` |
| L4 | Derive Update then Cancel | References valid; public feed rules for Actual only |
| L5 | Automated support | lifecycle + API integration tests |

### 5.3 Roles and sessions

| # | Check | Expect |
|---|-------|--------|
| R1 | Deactivate user mid-session | Subsequent API 401 |
| R2 | Viewer cannot admin users / audit export | 403 |
| R3 | Failed login | Generic 401; `login_failed` audit (admin-visible) |

### 5.4 Webhook, outbox, workers

| # | Check | Expect |
|---|-------|--------|
| W1 | Missing `X-Webhook-Source` | 401 |
| W2 | Replay same signature | One 202, rest rejected |
| W3 | Delivery worker | Lease/retry/dead-letter **internal** only |
| W4 | Automated | webhook + delivery + retention atomicity tests |

### 5.5 Restricted / Private

| Rule | Expect |
|------|--------|
| Default | Public-only API boundary remains; do **not** treat Restricted/Private as operationally accepted |
| If exercised | Only after institutional row 4 guidance; still no public feed leakage |
| Gate 8 | Row 4 stays **Open** until formal acceptance |

### 5.6 CAP 1.2

| Check | Evidence |
|-------|----------|
| XSD / types / references | `npm test` including `tests/cap-schema.test.js` |
| Public CAP XML | `GET /api/public/alerts/:identifier/cap.xml` for Actual Public only |
| Report | Attach CI run URL or local test log to the **technical** evidence folder — not as Gate 8 Accepted |

---

## 6. Pass / fail criteria (technical pack)

**Pass (technical):**
- I1–I3, L1–L4, R1–R3, W1–W3 succeed with recorded evidence  
- `GET /api/health` shows `external_adapters_enabled: false`  
- Full `npm test` green on the evaluated head  

**Fail:**
- Any cross-tenant data disclosure  
- External adapter effective send  
- Public feed shows Test/Exercise/Ack/Error  
- Audit chain verify fails  

**Not evaluated by this pack alone:** Gate 8 rows 1–14 (authority, legal, off-host backup sign-off, independent security review, external receiver acceptance, final signature).

---

## 7. Evidence log template (per run)

```
Run id:
Date (UTC):
Environment:
Git head:
Operator:

Scenario id:
Actor:
Result: PASS / FAIL
Notes:
Artifact paths:
```

Store completed logs with the institution; do not mark [`INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md`](INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md) Accepted from this pack alone.

---

## 8. Related automation (already in repo)

- `tests/cap-scope-isolation.integration.test.js`  
- `tests/recipient-auth.integration.test.js`  
- `tests/recipient-grant-enforcement.integration.test.js`  
- `tests/api.integration.test.js`  
- `tests/cap-lifecycle.integration.test.js`  
- `tests/cap-phase7-receivers.test.js`  
- `tests/retention-audit-atomicity.test.js`  
- `tools/cap-receivers/*`  

---

## 9. After this pack

1. Engineering: fix any technical FAIL on the Draft PR branch.  
2. Institution: execute Phase 4–5 using the canonical register only.  
3. No PR merge and no Go-Live until register row 14 is Accepted with Evidence ID, Date, and Approver.
