# Project Phase Board

Single board for the 28-step acceptance path.  
**Institutional closure is never implied by a green cell in the Engineering column.**

| Phase | Steps | Engineering / repo | Institution | Board status |
|-------|-------|--------------------|-------------|--------------|
| 1 Docs & refs | 1–5 | Unified heads; Open Gate 8 register | — | **Closed (docs)** |
| 2 Isolated pack | 6–10 | [ISOLATED_ACCEPTANCE_TEST_PACK.md](ISOLATED_ACCEPTANCE_TEST_PACK.md) | Provide host if not eng-owned | **Ready** |
| 3 Technical tests | 11–16 | Automated suites + matrix [ACCEPTANCE_EXECUTION_MATRIX.md](ACCEPTANCE_EXECUTION_MATRIX.md); CI green on `cfa124e` | Run operator scenarios; fill [ACCEPTANCE_EVIDENCE_LOG_TEMPLATE.md](ACCEPTANCE_EVIDENCE_LOG_TEMPLATE.md) | **Ready to execute** |
| 4 Institutional evidence | 17–25 | Templates only | [INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md](INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md) rows 1–13 | **Open** |
| 5 Final sign-off | 26–28 | — | Register row 14 + Go-Live decision | **Open** |

## Hard stops

- No PR #4 merge without explicit approval  
- No external adapters  
- No Go-Live until phase 5 row 14 Accepted with Evidence ID, Date, Approver  
