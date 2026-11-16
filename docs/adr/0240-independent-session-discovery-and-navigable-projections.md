# ADR 0240: Independent session discovery and navigable collaboration projections

- Status: Accepted
- Date: 2026-09-13
- Decision: D410
- Amends: ADR 0239

## Context

The host-owned collaboration ledger already permits a delivery between any two
existing Agent Session IDs, but Session Orchestrator's private recent-reference
store is not an authority for discovering those IDs. A session created through
the normal New Task flow can therefore be a valid communication target while
remaining invisible to `SessionTask.list`.

## Decision

The reviewed `desktop.control` catalog gains the additive read operation
`session/collaboration/list`. It returns at most 100 non-deleted Agent sessions
with their real Session IDs, titles, status, updated time, readable provider and
model labels, and bounded creation links.

The host sidebar projection adds readable `providerName` and `modelName` fields
plus at most eight `createdSessions` references. `createdBySession` and
`createdSessions` describe only durable Session Orchestrator creation links;
ordinary independently created sessions do not receive a fabricated creator.

## Compatibility and validation

The new operation and projection fields are additive. Existing `status`, `send`,
`spawn`, result, cancellation, private references, and session data are
unchanged.

The list is restricted to Agent sessions because the host already rejects
delivery to Plan and Goal sessions. Host-core projection tests cover readable
provider/model names, creator/created-session links, and independent session
discovery.

## Amendment (2026-09-13): reference availability

`SessionReference` gained an optional `available` field. The host reports
`available: false` for a `createdBySession`, `createdSessions`,
`currentTask.senderSession`, or `recentExchanges[].peer` reference whose session
row is deleted or absent, and falls back to the Session ID as the title.
