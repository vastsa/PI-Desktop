# ADR 0201: Explicit Plugin Project IDs and Host-Owned Session Refresh

- Status: Accepted
- Date: 2026-09-09
- Decision: D368

## Context

The P0/P1 plugin session API deliberately kept imported sessions unbound, but
external-history importers need an explicit way to place a session under a
durable project. The existing `workspace.set` method both creates a project and
changes the active workspace, so exposing it to plugins would couple import to
the user's current UI context.

## Decision

- Add the permission-gated `pi.project.create({ path })` API.
- Allow `projectId` on plugin import items.
- Make plugin session list/get projections report the explicit project binding
  and id while retaining ownership filtering and all existing import limits.
- Electron main emits one `pi-desktop/session/event/changed` event after each
  successful plugin import, batch import, rename, or delete.

The host RPC remains additive to protocol v11; the new `projects.create`
operation is only reachable from the permission-checked plugin bridge.

## Consequences

Importers can explicitly opt into a project-backed session without silently
activating a workspace or turning historical paths into tool roots.
