# ADR 0311: Recheck Live Work workspace identity at Host admission

- Status: Implemented candidate
- Date: 2026-09-29
- Related: Live Voice Work Integration, ADR 0284

## Context

Live Work binds a call to a local session and workspace in Electron Main. That
scope can become stale while a request is being classified. Rechecking it in
Main before calling AgentHost still leaves an asynchronous gap before the Host
persists a user message or admits a turn.

## Decision

Add an optional `expectedWorkspaceIdentity` to the local AgentHost turn-start
request. When supplied by trusted Main code, AgentHost compares it with the
fresh workspace identity returned by its session port before admission. A
mismatch is rejected as `WORKSPACE_CHANGED` before the turn or queue entry is
created. The value is not part of provider input, Renderer DTOs, RACP, or
persistence.

Existing non-Live callers omit the field and keep their current behavior. The
identity uses the existing Host session summary canonicalization; this change
does not create a second path-normalization rule or a database migration.

## Consequences

- Live work is checked at its final local admission owner as well as in Main.
- A workspace move during classification fails closed and requires a new
  explicitly bound work call.
- The AgentHost start-turn TypeScript contract gains one optional local field;
  no IPC or persisted data format changes.
- Tests must cover both unchanged identity admission and changed identity
  rejection without prompt or queue side effects.
