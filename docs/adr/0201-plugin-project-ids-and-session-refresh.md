# ADR 0201: Explicit Plugin Project IDs and Host-Owned Session Refresh

- Status: Accepted
- Date: 2026-09-09
- Related: D368

## Context

The plugin session API deliberately kept imported sessions unbound, but
external-history importers need an explicit way to place a session under a durable
project. `workspace.set` both creates a project and changes the active workspace, so
exposing it to plugins would couple import to the user's current UI context, and
plugin session writes had no renderer notification path, leaving the sidebar stale.

## Decision

Add the permission-gated `pi.project.create({ path })` API, which creates or reuses
a durable host project row without activating the workspace and returns the
host-generated `projectId`, canonical path, and display name. Plugin import items may
carry `projectId`, which must already exist and requires the `project.create`
permission, while omitted ids keep the safe unbound behavior and historical
`projectPath`, `modelId`, and `providerId` stay origin metadata. Plugin session list
and get projections report the explicit binding while keeping ownership filtering.
Electron main emits one `pi-desktop/session/event/changed` event after each
successful plugin import, batch import, rename, or delete, which the renderer handles
through `refreshSessions()`; skipped imports do not emit, and a refresh never reopens
a closed project tab. The host RPC stays additive to protocol v11.

## Consequences

- Importers opt into project-backed sessions without activating a workspace or
  turning historical paths into tool roots.
- The host owns sidebar synchronization, so import plugins need no private event
  bridge.
- The project permission is high risk, because an explicit project id is also a
  session tool-root authority, and users must approve it at install time.
