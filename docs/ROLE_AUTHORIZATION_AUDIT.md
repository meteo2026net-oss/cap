# Role Authorization Audit — CAP 1.2

Review basis: source and API integration tests on the active pull-request branch. This is a code-level authorization review, not an institutional approval of role assignments or operational warning procedures.

## Executive result

The role model has useful server-side route guards and several workflow-level separation checks, but it is not yet a complete separation-of-duties model.

- Reviewer and Approver currently share the same alert review, return, approve, and audit route permissions. The role names do not create distinct review and approval authorities.
- Forecasters can create and edit their own drafts. Draft editing checks authorship, but submission previously checked only the workflow state; a different forecaster could submit another user's draft if its identifier was known. The submission path is being hardened to require draft ownership for forecasters; administrators remain an explicit override.
- Publishers can publish approved alerts and operate the internal delivery outbox, but cannot approve alerts. The publisher who approved an alert is blocked from publishing that same alert.
- Viewers have authenticated Public-alert read access and no workflow, delivery, review, audit, or account-administration mutation permissions. Public reads are global, not organization- or jurisdiction-scoped.
- Administrators retain broad operational powers across account administration, authoring, review/approval, publishing, delivery, audit, metrics, and retention. Per-alert creator/approver/publisher checks reduce some conflicts, but the admin role remains a governance-level concentration of authority.

## Role-by-role findings

### 1. Reviewer and Approver

Current route behavior:

- Both roles can read the review queue, review notes/history, versions, timelines, and audit history.
- Both roles can add review notes, return pending alerts to draft, and approve pending alerts.
- Reviewer alone can inspect and disposition the inbound webhook inbox; Approver does not have that capability.
- A creator cannot add an independent review note, return their own pending alert, or approve their own alert.
- The application does not require a separate reviewer decision before an approver can approve. It has no distinct review-complete state or reviewer-to-approver handoff.
- Because Reviewer and Approver share the same approve route, the distinction between the two roles is currently descriptive rather than enforced for approval authority.

Risk / decision required:

- Approve an institutional policy that defines Reviewer as review/feedback/return only and Approver as final approval only, or explicitly approve a different quorum model.
- Define whether one or more reviewers are required, whether an approver must be a different person from every reviewer, and how re-review after edits is represented.
- Until that policy is approved, do not silently change role semantics or infer that a separate approval authority exists.

### 2. Forecaster

Current route behavior:

- Can create alerts and derive Update/Cancel messages.
- Can edit only their own draft; an administrator can edit another user's draft.
- Can submit a draft for review.
- Cannot access the review queue, reviewer notes/history/version/timeline views, approve, publish, inspect delivery outbox, or administer accounts.
- The Public-only scope boundary prevents valid Restricted/Private creation or promotion.

Finding and hardening:

- Draft edit already checks authorship; the submission route previously did not. This left an ownership gap in the draft lifecycle. The route now permits a forecaster to submit only their own draft, while an administrator remains an explicit override. An API regression test verifies that a second forecaster receives 403 and the owner can still submit.

### 3. Publisher

Current route behavior:

- Can publish only alerts in the approved workflow state.
- Cannot publish an alert if the same user is recorded as its approver.
- Can read/process the internal delivery outbox, claim entries, record receipts, retry, and invoke queue maintenance routes.
- Can read operational health metrics.
- Cannot create/edit/submit drafts, review/approve alerts, read the audit history, or administer accounts.
- The outbox is an internal queue only. No external transport adapter is enabled; delivery permissions do not prove recipient identity or successful external delivery.

Residual concern:

- Queue processing and operational metrics are bundled into the Publisher role. Consider whether queue operations should be a narrower delivery-operator capability distinct from publication, subject to institutional policy.

### 4. Viewer

Current route behavior:

- Can read authenticated Public alert lists, details, CAP XML, statistics, and CSV exports.
- Cannot access review queue/history, versions, timeline, review notes, inbound webhook inbox, audit history, delivery outbox, operational metrics, or account administration.
- Cannot create, edit, derive, submit, return, approve, publish, retry, or otherwise mutate workflow state.

Residual concern:

- Viewer reads are global across all Public alerts. They are not filtered by organization, tenant, jurisdiction, or recipient grant. This is a Public visibility policy question, not a role-guard defect. Restricted and Private remain blocked.

### 5. Admin

Current route behavior:

- Has broad access to account lifecycle, authoring, review/approval, publishing, delivery operations, audit, metrics, and retention.
- Cannot reset their own password through the administrator-assisted reset route or change their own role.
- Cannot deactivate themselves or remove the final active administrator.
- Peer-administrator password reset is blocked; the requesting administrator does not receive another administrator's temporary credential.
- Role/status/account mutations are audited, transactional where applicable, and protected by an administrator-specific rate limit. The default mutation limit is 30 operations per 15 minutes per authenticated administrator. Administrator-assisted password resets have a separate default limit of 5 per 15 minutes; both limits are configurable through validated environment settings.
- Per-alert workflow guards prevent the creator from approving their own alert and prevent the approving user from publishing that same alert.

Residual concern:

- Admin can still create or promote another admin and can reset non-admin accounts. There is no dual authorization or independent second-actor approval for privileged grants.
- Admin's ability to act across authoring, approval, publishing, and delivery means application-level separation of duties is not absolute. Per-alert maker/checker checks help, but do not replace independent governance, privileged-access monitoring, and periodic access recertification.
- MFA is mandatory only for roles listed in MFA_REQUIRED_ROLES; an empty configuration does not require MFA for any role.

## Cross-role matrix

| Capability | Admin | Forecaster | Reviewer | Approver | Publisher | Viewer |
|---|---:|---:|---:|---:|---:|---:|
| Read authenticated Public alerts | Yes | Yes | Yes | Yes | Yes | Yes |
| Create / derive drafts | Yes | Yes | No | No | No | No |
| Edit own draft | Yes | Yes | No | No | No | No |
| Submit draft | Yes | Own drafts | No | No | No | No |
| Review queue / notes / history | Yes | No | Yes | Yes | No | No |
| Return pending alert | Yes | No | Yes | Yes | No | No |
| Approve pending alert | Yes | No | Yes | Yes | No | No |
| Publish approved alert | Yes | No | No | No | Yes | No |
| Inbound webhook review | Yes | No | Yes | No | No | No |
| Delivery outbox / retry operations | Yes | No | No | No | Yes | No |
| Operational metrics | Yes | No | No | No | Yes | No |
| Audit read / verification | Yes | No | Yes | Yes | No | No |
| Account administration | Yes | No | No | No | No | No |
| Operational retention | Yes | No | No | No | No | No |

## Required follow-up gates

1. Approve and implement a distinct review/approval state machine, including reviewer identity, approver identity, re-review after material edits, quorum, and conflict-of-interest rules.
2. Add explicit tests that Reviewer cannot approve if the institution adopts a review-only role, and that Approver cannot perform reviewer-only decisions.
3. Decide whether Publisher should be split from delivery-queue operations.
4. Decide whether Admin's broad operational override is retained, constrained, or subject to dual control and independent monitoring.
5. Decide whether Public reads are intentionally global or require jurisdiction/organization filtering.
6. Keep MFA_REQUIRED_ROLES explicitly configured by the deployment authority; do not treat an unset value as MFA enforcement.
7. Keep Restricted and Private disabled until the recipient authorization design is approved, implemented, and tested across all read, export, mutation, audit, and delivery paths.

## Safety boundary

This audit does not grant recipient permissions, create organization memberships, change account records, or enable external delivery. CAP addresses and restriction remain message metadata, not access-control lists. The Public-only boundary remains in force and external_adapters_enabled: false remains unchanged.
