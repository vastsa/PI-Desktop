# ADR 0274: A development plugin is reviewed before it is loaded

- Status: Accepted for implementation
- Date: 2026-09-17
- Related: [ADR 0005](0005-user-installable-plugin-system.md) ·
  [ADR 0110](0110-plugin-panel-chrome-spacing-contract.md) ·
  [07-plugins/13](../spec/07-plugins/13-plugin-permissions-matrix.md)

## Context

A plugin's permissions are approved by the user at load time and hot reload
never widens that ceiling, but loading a development folder passed the manifest
declaration straight through as the grant, and manual Reload used the registry
row's list while `watchDevPlugin` recorded the intersection as the new ceiling.
A manifest edit that added a permission therefore reloaded silently with it
dropped, leaving a half-broken plugin behind a `PERMISSION_DENIED` message that
pointed at a picker which reviewed nothing.

## Decision

Choosing a development plugin folder becomes a request, not consent:
`plugin/loadDev` returns the validated `PluginPermissionReview` — id, name,
version, declared permissions, and what is beyond the current approval —
without registering or loading anything, and `plugin/loadDevConfirm` commits it
by registering the folder, loading it with the accepted permissions only, and
arming the watcher on that same set. `plugin/reload` compares the manifest
against the recorded approval (`PluginRuntime.devApproval`) rather than the
registry row, counting a new file glob exactly like a new permission, so an edit
that adds nothing reloads immediately while one that widens returns a review and
keeps the plugin running under its current approval until
`plugin/reloadConfirm` answers. The scaffold flow returns the same review, and
paths and identities in a confirmation come from the host, never from a
renderer-chosen path for an already-registered plugin. Both reviews render
through one `PermissionGroups` component, and the hot-reload refusal now points
at the Plugins page.

## Consequences

- A plugin author sees the same review as a marketplace install, at folder
  selection and whenever an edit asks for more, and the answer rather than the
  manifest is what the runtime enforces.
- Widening can no longer produce a half-working plugin, and nothing is granted
  against an unreadable manifest.
- The registry row always states the current declaration, while the approval is
  the watcher ceiling that reload compares against.
