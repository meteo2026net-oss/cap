# Phase Execution Record

## Current-head CI follow-up — 2026-11-08 UTC

- PR #4 head: `ee3bda3e1ebc57528159a7692c247c5d29eb0986` (Draft, not merged).
- Changed `.github/workflows/test.yml` to run the Windows backup job on `windows-2022`, which provides the stable Visual Studio 2022 toolchain expected by `node-gyp`. The prior `windows-latest` image exposed Visual Studio 18, which the installed `node-gyp` could not detect; `npm ci` therefore failed before backup/restore or PowerShell tests ran.
- This is a CI runner compatibility adjustment; no dependency versions, application behavior, test assertions, or production configuration were changed.
- CAP System Checks and CodeQL for this exact head are pending/not yet confirmed. The Windows backup/restore result must be observed on this exact SHA before the issue is considered resolved.
- Historical CI records below remain historical and must not be read as validation of this newer head.
- `external_adapters_enabled: false`; Gate 8 remains Open; no Go-Live or institutional acceptance is claimed.


**Recorded:** 2026-11-08 (UTC)  
**Branch:** `fix/retention-audit-atomicity`  
**PR #4 head:** `26e7cf45889cffdb0fd9b3be2c6a750755e235d0` — **Draft**, not merged  
**external_adapters_enabled:** false  

## Automated technical evidence (Phase 3 suite via CI)

| Workflow | Head | Conclusion | Run |
|----------|------|------------|-----|
| CAP system checks | `26e7cf45889c` | **success** | https://github.com/meteo2026net-oss/cap/actions/runs/42450809724 |
| CodeQL | `26e7cf45889c` | **success** | https://github.com/meteo2026net-oss/cap/actions/runs/42450809620 |
| Acceptance two-tenant test | included in CAP suite | **pass** | password-change path + inbox isolation |


| Workflow | Head | Conclusion | URL |
|----------|------|------------|-----|
| CAP system checks | `26e7cf45889cffdb0fd9b3be2c6a750755e235d0` | **success** | https://github.com/meteo2026net-oss/cap/actions/runs/42447889994 |
| CodeQL security analysis | `26e7cf45889cffdb0fd9b3be2c6a750755e235d0` | **success** | https://github.com/meteo2026net-oss/cap/actions/runs/42447890005 |

This satisfies the **automated** portion of steps 11–16 (isolation, lifecycle, roles, webhook/outbox, Public-only boundary, CAP schema) as exercised in the repository test suite.

## Operator isolated scenarios (Phase 2–3)

Defined in [ISOLATED_ACCEPTANCE_TEST_PACK.md](ISOLATED_ACCEPTANCE_TEST_PACK.md) (I1–I3, L1–L4, R1–R3, W1–W3).  
**Status:** Pack ready · **not** auto-closed by CI · fill [ACCEPTANCE_EVIDENCE_LOG_TEMPLATE.md](ACCEPTANCE_EVIDENCE_LOG_TEMPLATE.md) on the institution host.

## Phase board

| Phase | Steps | Execution status |
|-------|-------|------------------|
| 1 Docs | 1–5 | **Executed (repo)** |
| 2 Pack | 6–10 | **Prepared (repo)** — host bootstrap by operator |
| 3 Technical | 11–16 | **Automated: executed via CI success on `639e11a`** · Operator scenarios: pending host run |
| 4 Institutional | 17–25 | **Not executed** — external parties required · register Open |
| 5 Sign-off | 26–28 | **Not executed** — owning body required · register Open |

## Explicit non-claims

- Gate 8 is **not** closed.  
- No Go-Live.  
- No external adapter enablement.  
- No CAP certification.  
- CI success is not institutional acceptance.
