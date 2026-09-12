# ADR 0201: Explicit Plugin Project IDs and Host-Owned Session Refresh

- Status: Accepted
- Date: 2026-09-09
- Decision: D368

## Context

The P0/P1 plugin session API deliberately kept imported sessions unbound, but
external-history importers need an explicit way to place a session under a
durable project. The existing `workspace.set` method both creates a project and
changes the active workspace, so exposing it to plugins would couple import to
the user's current UI context. Plugin session writes also currently have no
renderer notification path, leaving the sidebar stale until another refresh.

## Decision

- Add the permission-gated `pi.project.create({ path })` API. It creates or
  reuses a durable host project row without activating the workspace and
  returns the host-generated `projectId`, canonical path, and display name.
- Allow `projectId` on plugin import items. The id must already exist and the
  plugin must hold `project.create`; omitted ids preserve the safe unbound
  behavior. `projectPath`, `modelId`, and `providerId` remain historical
  origin metadata unless an explicit active binding is supplied.
- Make plugin session list/get projections report the explicit project binding
  and id while retaining ownership filtering and all existing import limits.
- Electron main emits one `pi-desktop/session/event/changed` event after each
  successful plugin import, batch import, rename, or delete. The renderer
  handles it through the existing `refreshSessions()` store action. Skipped
  imports do not emit the event, plugins never emit it, and a refresh never
  reopens a closed project tab.

The host RPC remains additive to protocol v11; the new `projects.create`
operation is only reachable from the permission-checked plugin bridge.

## Consequences

Importers can explicitly opt into a project-backed session without silently
activating a workspace or turning historical paths into tool roots. The host
owns sidebar synchronization, so import plugins do not need a private event
bridge. The project permission is high risk because an explicit project id is
also a session tool-root authority; users must approve it at install time.

## Verification

Coverage includes project creation without workspace switching, explicit and
unknown project ids during import, bound list/get projections, independent
project permission checks, and the host-to-renderer refresh event contract.
E2E-216 records the full UI journey; local UI E2E remains deferred by policy.
