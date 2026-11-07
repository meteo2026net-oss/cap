# Interoperability

## Local receivers
`tools/cap-receivers/receiver-a.mjs` and `receiver-b.mjs` are independent local consumers used in automated tests. They do not send network traffic.

## Covered
- Alert/Update/Cancel/Ack/Error message types
- Public/Restricted/Private scope checks at receiver edge
- Required CAP 1.2 namespace enforcement (default and prefixed namespace forms)
- Exact sender/identifier/sent reference resolution against persisted receiver history
- Update-before-Alert rejection until the referenced Alert is durably stored
- Arabic text and compacted XML tolerance
- Duplicate identity collapse
- Update-before-Alert deferral policy example

## Not claimed
- Certification by OASIS
- Production exchange with external warning authorities
- Enabled webhooks or external adapters
