# Institutional Evidence Workbook (Phase 4 — Steps 17–25)

**Purpose:** Collect **real** institutional evidence for Gate 8 register rows.  
**Canonical status board:** [INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md](INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md) only.  
**This workbook does not accept any row.** Filling templates here is preparation, not approval.

**PR #4:** Draft · **external_adapters_enabled:** false · **Gate 8:** Open  

Engineering CI success is **not** evidence for any form below.

---

## How to complete a row

1. Complete the matching form in this workbook (or attach equivalent institutional document).  
2. Assign **Evidence ID** (e.g. `INST-2026-001`).  
3. Obtain **Approver** name, role, and date.  
4. Only then update the matching row in `INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md` to **Accepted**.  
5. Store signed PDFs / tickets outside git if they contain sensitive data; record only IDs and pointers in the register.

---

## Step 17 / Register row 1 — Owning institution and warning authority

| Field | Value (to be filled by institution) |
|-------|-------------------------------------|
| Legal name of owning institution | |
| Unit accountable for the CAP service | |
| Named warning authority (role + person) | |
| Named service owner (role + person) | |
| Scope of authority (geography / hazards) | |
| Evidence ID | |
| Approver / Date | |
| Status | **Open** |

---

## Step 18 / Register row 2 — Geography, language, severity, public feed

**Product intent (pre-filled for institutional confirmation):** Deployment and warning responsibility are limited to the **Syrian Arab Republic**. This system is a **local programme**, not a global alert distribution service. Institution may narrow further (governorates / areas) but should not expand to worldwide dissemination without a new explicit decision.

| Field | Value |
|-------|-------|
| Approved geographies / CAP area policy | Default intent: Syrian Arab Republic only; list any sub-national limits |
| Approved languages | |
| Severity / urgency / certainty policy | |
| Public feed policy (Actual only? Test handling?) | |
| Document reference (policy ID / URL internal) | |
| Evidence ID | |
| Approver / Date | |
| Status | **Open** |

---

## Step 19 / Register row 3 — Roles, identity, MFA, separation of duties

| Field | Value |
|-------|-------|
| Authoritative role roster (admin, forecaster, reviewer, approver, publisher, viewer, …) | |
| Identity source (local accounts / IdP) | |
| MFA policy (`MFA_REQUIRED_ROLES` and exceptions) | |
| Approval quorum / four-eyes rules | |
| Conflict-of-interest (creator cannot approve) — confirmed in policy? | |
| Break-glass procedure | |
| Evidence ID | |
| Approver / Date | |
| Status | **Open** |

Software supports roles/MFA; **policy acceptance is institutional.**

---

## Step 20 / Register row 4 — Organizations, recipients, Restricted / Private

| Field | Value |
|-------|-------|
| Multi-tenant organization model accepted? | |
| Recipient identity mapping | |
| Grant / revoke process + dual control | |
| Restricted audience definition | |
| Private addresses definition | |
| Decision on re-enabling non-Public API paths | **Must remain denied until this row Accepted** |
| Evidence ID | |
| Approver / Date | |
| Status | **Open** |

---

## Step 21 / Register rows 5–6 — Secrets, infrastructure, HTTPS

| Field | Value |
|-------|-------|
| JWT secret management + rotation | |
| MFA encryption key management + rotation | |
| Admin bootstrap / password custody | |
| TLS terminator / certificate owner | |
| Network allow-list / admin access policy | |
| Staging vs production acceptance | |
| Evidence ID (secrets) | |
| Evidence ID (HTTPS / env) | |
| Approver / Date | |
| Status | **Open** |

---

## Step 22 / Register rows 7–8 — Off-host backup and restore drill

| Field | Value |
|-------|-------|
| Off-host encrypted backup location | |
| Retention schedule + monitoring | |
| Documented RTO | |
| Documented RPO | |
| Restore drill date | |
| Restore drill result (PASS/FAIL) | |
| Signed by (operations) | |
| Evidence ID | |
| Status | **Open** |

Repo tooling (`npm run backup` / restore / drill) is **not** a signed off-host drill by itself.

---

## Step 23 / Register row 9 — Independent security review

| Field | Value |
|-------|-------|
| Reviewing party (independent of build team) | |
| Scope (app / infra / config) | |
| Report ID + date | |
| Critical/high findings count | |
| Disposition plan + residual risk acceptance | |
| Evidence ID | |
| Approver / Date | |
| Status | **Open** |

CodeQL in CI is **not** a substitute for this row.

---

## Step 24 / Register rows 10–11 — External receivers and distribution channels

| Field | Value |
|-------|-------|
| External receiver name / version | |
| Test message IDs accepted | |
| Test message IDs rejected (and why) | |
| Channel decision: keep adapters **disabled** / enable after acceptance | **Default remains disabled** |
| Decision owner + date | |
| Evidence ID (interop) | |
| Evidence ID (channel decision) | |
| Status | **Open** |

Local `tools/cap-receivers` do **not** satisfy row 10.

---

## Step 25 / Register rows 12–13 — Institutional acceptance drill and legal/comms

| Field | Value |
|-------|-------|
| Drill date / environment | |
| Two tenants exercised? | |
| Full lifecycle + webhook review + failure/restore? | |
| Roles exercised | |
| Drill report ID | |
| Legal / communications approval for Actual public warnings | |
| Evidence ID (drill) | |
| Evidence ID (legal/comms) | |
| Status | **Open** |

---

## Phase 4 exit checklist

- [ ] Rows 1–13 have Evidence ID + Date + Approver in the **canonical register**  
- [ ] No row Accepted solely because CI was green  
- [ ] External adapters still false unless row 11 explicitly enables them after acceptance  
- [ ] Restricted/Private operational use blocked until row 4 Accepted  
- [ ] Ready for Phase 5 (rows 14 + Go-Live decision) only after the above  

**Phase 4 status in this repository: templates ready · all institutional rows remain Open.**
