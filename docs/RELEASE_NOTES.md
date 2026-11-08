# Release Notes

## Current mainline (test platform)

Software phases through organization-bound webhooks, operational retention, and local receivers are implemented on branch `fix/retention-audit-atomicity` (PR #4, Draft). PR head and software verification head (CAP system checks + CodeQL success): `cfa124e5d45c2815abe78604b742317333a71687`. Institutional Gate 8 remains Open — canonical register: [`INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md`](INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md).

### CAP and lifecycle
- CAP 1.2 Alert / Update / Cancel / Ack / Error with references and OASIS XSD checks
- Public / Restricted / Private scope fields; public feeds expose Public only
- Immutable version snapshots, review notes, timeline

### Security and tenancy
- JWT auth, role separation, MFA for configured roles
- Audit hash chain with verification and export
- Organization membership model; webhook sources bound to organizations
- Inbox visibility scoped by active membership (admins retain global triage)

### Operations (internal only)
- Delivery outbox with leases and retries — **no external transport**
- `external_adapters_enabled: false` on health and delivery responses
- Retention apply with atomic audit (`retention_applied`); metrics endpoint
- Backup / restore tooling and checkpoint refresh gated by operator attestation

### Interoperability simulation
- Independent local receivers A (xmlbuilder2) and B in `tools/cap-receivers/`
- Namespace enforcement, DTD rejection, Arabic content, dedupe, Update-before-Alert ordering

## Explicit non-goals
- Gate 8 institutional acceptance is tracked only in `INSTITUTIONAL_ACCEPTANCE_EVIDENCE.md` and is **Open**

- External CAP / email / SMS / government-gateway delivery remains disabled
- Not institutionally certified for public warning issuance
- Restricted / Private recipient grants are not a substitute for organizational go-live acceptance
- A green CI run is not authority to issue Actual public warnings
