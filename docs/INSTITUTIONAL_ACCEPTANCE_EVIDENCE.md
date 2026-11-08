# Institutional Acceptance Evidence Register (Gate 8) — CANONICAL

> **This is the sole reference register for institutional / Gate 8 acceptance.**  
> Other documents may link here; they must not mark Gate 8 rows Accepted on their own.  
> Automated tests, CodeQL, documentation commits, and PR #4 Draft status are **not** acceptance evidence.

**PR #4 head (current tip at documentation update):** `cfa124e5d45c2815abe78604b742317333a71687` (Draft, not merged)
**Software verification on that head:** CAP system checks **success** · CodeQL **success**
**Institutional Gate 8:** **Open** — sole register: [`INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md`](INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md)
**external_adapters_enabled:** **false**

## How to use

For each row:

1. Leave **Status** as `Open` until institutional evidence exists.  
2. Set **Status** to `Accepted` only with **Evidence ID**, **Date**, and **Approver**.  
3. Never set `Accepted` because automated tests passed or a doc was committed.

## Register

| # | Required evidence | Responsible party | Evidence ID | Date | Approver | Status |
|---|-------------------|-------------------|-------------|------|----------|--------|
| 1 | Named warning authority and accountable service owner | Owning institution | | | | Open |
| 2 | Approved geography, languages, severity policy, public-feed scope | Warning authority / policy | | | | Open |
| 3 | Role roster, approval quorum, conflict-of-interest, MFA, break-glass | Security & governance | | | | Open |
| 4 | Restricted/Private recipient model (identity, membership, grant/revoke, dual control) | Identity & beneficiary owners | | | | Open |
| 5 | Production secrets management (JWT, MFA key, admin bootstrap) + rotation | Infrastructure | | | | Open |
| 6 | HTTPS, network access policy, staging/production environment acceptance | Infrastructure | | | | Open |
| 7 | Off-host encrypted backup storage, retention, monitored schedule | Operations | | | | Open |
| 8 | Documented RTO/RPO + **signed** restore drill against production-like backup | Operations | | | | Open |
| 9 | Independent application/infrastructure/config security review + finding disposition | Independent security party | | | | Open |
| 10 | Interoperability tests with each required external receiver (name/version, IDs, accept/reject) | Receiving-system owners | | | | Open |
| 11 | Explicit decision: keep external adapters disabled **or** enable after channel acceptance | Service owner + authorized body | | | | Open |
| 12 | Isolated drill: two tenants, full alert lifecycle, webhook review if used, failure/restore, all roles | Ops + test team | | | | Open |
| 13 | Legal/communications approval for Actual public warnings | Legal / communications | | | | Open |
| 14 | Final operational acceptance record (engineering sign-off alone insufficient) | Authorized owning body | | | | Open |

## Binding constraints until rows are Accepted

- Do not issue Actual public warnings from this system under institutional authority.  
- Do not enable external delivery adapters in configuration or code paths used for operations.  
- Do not treat Restricted/Private as production-ready recipient authorization.  
- Do not close Gate 8 in `GATE_STATUS.md` until row 14 is Accepted with evidence recorded in **this** file.

## Relationship to software evidence

Software evidence lives under tests, CI, and documents such as `OPERATIONAL_ACCEPTANCE.md` section A and `CAP_CONFORMANCE_MATRIX.md`.  
Those artifacts support technical readiness discussions only. They are **inputs** to this register, not substitutes for it.
