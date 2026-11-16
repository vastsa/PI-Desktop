# ADR 0240: Independent session discovery and navigable collaboration projections

- Status: Accepted
- Date: 2026-09-13
- Decision: D410
- Amends: ADR 0239

## Context

The host collaboration ledger permits delivery between any two existing Agent Session
IDs, but Session Orchestrator's private recent-reference store is not an authority for
discovering them, so a session created through New Task can be a valid target while
staying invisible to `SessionTask.list`.

## Decision

The reviewed `desktop.control` catalog gains the additive read operation
`session/collaboration/list`, returning up to 100 non-deleted Agent sessions with
their real Session IDs, titles, status, updated time, readable provider and model
labels, and bounded creation links, but no project paths, credentials, transcripts, or
previews; `send` stays the authenticated mutation path. The sidebar projection adds
`providerName`, `modelName`, and at most eight `createdSessions` references, and since
`createdBySession` describes only durable creation links, an independently created
session gets no fabricated creator.

The renderer renders references as keyboard-focusable buttons that open the durable
session and focus the Composer, the hover card stays on-demand and bounded, and
Session Orchestrator keeps the legacy `workers` field beside the new host-backed
`sessions` directory.

## Amendment (2026-09-13): reference availability

`SessionReference` gained an optional `available` field that the host reports as
`false` for a `createdBySession`, `createdSessions`, `currentTask.senderSession`, or
`recentExchanges[].peer` reference whose session row is deleted or absent.

## Consequences

- Any existing Agent session is a discoverable collaboration target.
- Unavailable references render as plain text, and activating a vanished session
  reports a visible error instead of an empty selection.
- The optional field is additive, so existing callers and persisted data are
  unaffected.

## Alternatives

- Keep the private recent-reference store as the discovery authority — rejected: it
  hides valid targets.
