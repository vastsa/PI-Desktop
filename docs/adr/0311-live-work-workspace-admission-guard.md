# ADR 0311: Recheck Live Work workspace identity at Host admission

- Status: Implemented candidate
- Date: 2026-09-29
- Related: Live Voice Work Integration, ADR 0284

## Context

Live Work binds a call to a local session and workspace in Electron Main, but that
scope can go stale while a request is classified, and rechecking in Main still
leaves a gap before the Host persists a message or admits a turn.

## Decision

Add an optional `expectedWorkspaceIdentity` to the local AgentHost turn-start
request, which AgentHost compares with the fresh identity from its session port
before admission and rejects as `WORKSPACE_CHANGED` before any turn or queue entry
exists; the value stays out of provider input, Renderer DTOs, RACP, and
persistence, and non-Live callers omit it.

## Consequences

- Live work is checked at its final local admission owner, and a workspace move
  during classification fails closed.
- The start-turn contract gains one optional local field; no IPC or persisted
  format changes.
