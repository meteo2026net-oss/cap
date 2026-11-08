# Software Completion Record

**Branch:** `fix/retention-audit-atomicity`  
**Completion head:** `a5225a61023e1030fdbe8ddd18b8eba79fbcdba8`  
**CI on this head:** CAP system checks **success** · CodeQL **success**  
**PR #4:** Draft — **not merged** (requires explicit human approval)  
**external_adapters_enabled:** **false**

## What “complete” means here

This record closes the **software delivery** for the CAP test platform on this branch: implemented features, automated tests, and repository documentation.

It does **not** close **Gate 8 (institutional acceptance)**.  
Gate 8 is tracked only in [`INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md`](INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md) and remains **Open**.

| Claim | Allowed? |
|-------|----------|
| Software suite green on completion head | Yes |
| Ready for isolated technical evaluation / Test data | Yes, with docs |
| Institutional go-live / Actual public warnings | **No** |
| External email/SMS/outbound webhook delivery enabled | **No** |
| CAP certification | **No** |
| Gate 8 closed | **No** |

## Software scope delivered

1. **CAP 1.2** — Alert/Update/Cancel/Ack/Error, validation, OASIS XSD tests, references, scopes  
2. **Alert lifecycle** — draft, edit, submit, review, approve, publish, derive update/cancel, versions, timeline  
3. **Security** — JWT, roles, MFA, session revocation, failed-login audit, org membership, IDOR tests  
4. **Webhooks** — org-bound sources, HMAC, replay guard, membership-scoped inbox  
5. **Maps / GeoJSON** — Leaflet UI, CAP geometry validation, public GeoJSON + JSON + CAP XML (Actual/Public only)  
6. **Delivery (internal)** — outbox, leases, retries, dead-letter, worker maintenance only  
7. **Reliability** — audit hash chain, retention atomicity, backup/restore/drill tooling, perf harness  
8. **Ops docs** — architecture, API, deployment, runbook, DR, gate status, institutional register  

## Explicit non-delivery (by policy)

- External transport adapters  
- Institutional sign-off, off-host backup operations, independent pentest  
- Production HTTPS/secrets ownership  
- Re-opening Restricted/Private as operational recipient authorization without register row 4 Accepted  

## How to proceed after this record

1. Keep PR #4 in Draft until an explicit merge decision.  
2. Run institutional drills and fill [`INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md`](INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md).  
3. Only after register row 14 is Accepted may Gate 8 be marked closed in `GATE_STATUS.md`.  

**Software completion: yes (this head).**  
**Project institutional completion / go-live: no.**
