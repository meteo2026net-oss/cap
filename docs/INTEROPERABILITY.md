# Interoperability

## Local receivers
`tools/cap-receivers/receiver-a.mjs` and `receiver-b.mjs` are independent local consumers used in automated tests. They do not send network traffic.

## Covered
- Alert/Update/Cancel/Ack/Error message types
- Public/Restricted/Private scope checks at receiver edge
- Arabic text and compacted XML tolerance
- Duplicate identity collapse
- Update-before-Alert deferral policy example

## Not claimed
- Certification by OASIS
- Production exchange with external warning authorities
- Enabled webhooks or external adapters
