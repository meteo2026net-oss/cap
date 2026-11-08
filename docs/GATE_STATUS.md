# Project Gate Status (Software Evidence)

Last verified head: `b991d5c411b81a6fe18bc9112c91f7206b809f08`  
PR #4: Draft (not merged)  
`external_adapters_enabled`: **false**

Legend: **Done** = automated evidence in repo/CI · **Partial** = core present, institutional or external work remains · **Open** = not claimed

## Gate 1 — Stabilize current revision
| Item | Status |
|------|--------|
| Pin SHA + review commits | **Done** — `docs/PHASE1_BASELINE.md` |
| Review PR #4 changes | **Done** |
| Admin audit assertions | **Done** (CI) |
| Webhook pagination + isolation | **Done** (CI) |
| Schema migrate | **Done** |
| Full suite green | **Done** — CAP checks + CodeQL success |

## Gate 2 — CAP correctness + alert lifecycle
| Item | Status |
|------|--------|
| CAP XML structure, required fields, XSD | **Done** — `tests/cap-schema.test.js`, `cap.test.js` |
| Alert/Update/Cancel/Ack/Error | **Done** |
| Languages, timezones, resources | **Done** (local + XSD negatives) |
| Block update of missing/inactive source | **Done** — publish/derive paths |
| Identifier uniqueness | **Done** — DB UNIQUE + server-generated IDs |
| Version history | **Done** |
| Full workflow draft→review→approve→publish→update/cancel | **Done** — lifecycle integration tests |

## Gate 3 — Institutional security
| Item | Status |
|------|--------|
| Auth, sessions, MFA, roles | **Done** |
| Organizations + membership | **Done** |
| IDOR / cross-tenant tests | **Done** — scope isolation + recipient tests |
| Deactivated session invalidation | **Done** |
| Restricted/Private recipient grants | **Partial** — model/tests exist; Public-only API boundary still enforced for non-Public rows |

## Gate 4 — Maps + webhook sources
| Item | Status |
|------|--------|
| Leaflet map, draw polygon/circle, GeoJSON import preview | **Done** (UI) |
| CAP area/polygon/circle/geocode validation | **Done** |
| Org-bound webhook sources, HMAC, replay | **Done** |
| Inbox review + org isolation | **Done** |

## Gate 5 — Delivery
| Item | Status |
|------|--------|
| Outbox, leases, retries, dead-letter | **Done** (internal) |
| Workers | **Done** — `delivery-worker.js` internal maintenance only |
| External email/SMS/webhook transport | **Open by policy** — adapters disabled until explicit acceptance |

## Gate 6 — Reliability
| Item | Status |
|------|--------|
| Retention + audit atomicity | **Done** |
| Backup/restore/drill | **Done** (tooling + tests) |
| Perf smoke / 10k harness | **Done** in CI; target-host capacity **Open** |

## Gate 7 — Operations
| Item | Status |
|------|--------|
| Health/ready/metrics | **Done** |
| Docs (deploy, runbook, DR, API) | **Done** (repository docs) |
| Staging/prod/HTTPS institutional setup | **Open** (environment, not code) |

## Gate 8 — Final acceptance
| Item | Status |
|------|--------|
| Isolated two-tenant operational drill with signed report | **Open** — requires human operators |
| Independent security review | **Open** |
| Legal/authority approval for Actual public warnings | **Open** |

## Rule compliance
- No PR #4 merge without explicit approval
- No weakening of security tests for green CI
- No external delivery enablement
- No production-readiness claim
