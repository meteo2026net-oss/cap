# Delivery and Background Processing — Recipient Scope Audit

Audit baseline: code reviewed on commit `110da378895ee5bab68be7ef96419aed7a1f5990`.
Implementation status: Public-only enforcement strengthened; recipient grants remain unimplemented.

## Scope and findings

The review traced every delivery state transition and background maintenance entry point in `src/server.js`, `src/delivery.js`, and `src/delivery-worker.js`.

| Path | Existing boundary and audited behavior | Additional enforcement |
|---|---|---|
| Publish / outbox enqueue | Publish requires an approved alert and a separate publisher; it builds CAP XML and enqueues inside the publish transaction. | `enqueueDelivery` now rejects missing or non-Public alerts, and its `INSERT … SELECT` includes the Public predicate atomically. |
| Outbox list and counts | Admin/publisher only; both rows and aggregate counts are SQL-filtered to Public alerts. | No change required. |
| Claim | Admin/publisher only; non-Public delivery IDs are concealed by the delivery middleware. | The claim UPDATE itself requires a matching Public alert. |
| Receipt | Admin/publisher only; ID is concealed for non-Public records and the receipt requires the current lease token. | Both receipt lookup and UPDATE require Public scope. |
| Manual retry | Admin/publisher only; non-Public delivery IDs are concealed. | Retry UPDATE requires Public scope. |
| Due retry / dead-letter maintenance | Admin/publisher endpoint and the background worker use the same maintenance functions. The endpoint and worker retain a global fail-closed pause when any non-Public outbox row exists. | Selection and mutation SQL both constrain work to Public alerts, so a skipped/late global pre-check cannot broaden the affected rows. |
| Stale lease recovery | Admin/publisher endpoint and background worker use the same recovery function; the endpoint and worker retain the global non-Public pause. | Selection and both recovery UPDATE statements constrain work to Public alerts. |
| Audit and timeline | Delivery actions are linked to alert IDs; audit list/export filters alert-linked entries to Public alerts, and alert-linked routes retain the scope concealment middleware. | No new disclosure route was found in the delivery lifecycle. |
| Inbound webhook inbox | Optional, disabled by default, and manual-review-only. Review changes inbox state; it does not enqueue, publish, or fan out alerts. | No delivery adapter or subscriber fan-out exists. |

## Regression coverage added

- Unit tests reject enqueue for missing, Restricted, and Private alerts.
- Legacy non-Public outbox rows are inserted directly in fixtures to verify detection without using the guarded enqueue API.
- Unit tests prove non-Public queued rows cannot be claimed, failed rows cannot be retried, and sending rows cannot accept receipts.
- Unit tests prove retry maintenance and stale-lease recovery do not requeue, recover, or dead-letter non-Public rows.
- Integration tests assert non-Public delivery IDs return 404 for claim, retry, and receipt; global retry and stale-recovery endpoints remain blocked while legacy non-Public outbox entries exist.

## Background worker boundary

`src/delivery-worker.js` performs internal queue maintenance only: stale lease recovery and due retry scheduling. It does not send CAP messages or call email, SMS, push, webhook, government gateway, or other external providers. `external_adapters_enabled` remains `false`. The authenticated claim endpoint returns an internal payload and lease to an admin/publisher; it does not perform network transmission.

## Residual limitations and reopening gate

- The application still has no organization, recipient-group, or per-user grant model. Role membership is not recipient authorization.
- Existing Restricted/Private alerts and their legacy outbox entries remain stored but unavailable through application delivery APIs. The global worker/maintenance pause remains intentionally conservative while any such outbox entry exists.
- Application routes prevent non-Public scope promotion while recipient authorization is absent. Direct database edits or out-of-band scripts are outside the application authorization boundary and must not be used to reopen scopes.
- A full recipient-aware queue requires institution-approved grant semantics, identity verification, and explicit policy for queued/in-flight work after grant expiry or revocation. These changes are not implemented here.
- Do not enable external adapters or reopen Restricted/Private delivery until the approved recipient-grant design and cross-organization revocation tests are implemented and accepted.

This audit is a source-and-regression-test review, not an independent penetration test, certification, or production-readiness approval.
