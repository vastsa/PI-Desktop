# ADR 0075: Manual reload for development-plugin permission ceilings

- Status: Accepted
- Date: 2026-08-12

## Context

The development-plugin watcher refuses a manifest that adds permissions beyond the
ceiling approved when the folder was loaded, so the developer had to re-pick the
folder to resume.

## Decision

Add a renderer-to-main `pi-desktop/plugin/reload` invoke channel: Electron main
resolves the plugin id through the host registry, loads the registered path with the
registry's current permissions, and re-arms the development watcher after a
successful load. Only `source: "dev"` rows expose it.

The watcher stays conservative and cannot widen the ceiling; a manual reload is an
explicit developer action that makes the current manifest's permissions the new
ceiling.

## Consequences

Developers recover without re-picking a folder, other plugin sources gain no such
control, and the channel is an additive Electron IPC surface with unchanged watcher,
runtime, and storage contracts.

## Alternatives

- Reuse the folder picker: rejected, it repeats path selection.
- Let automatic reloads widen permissions: rejected, file edits must not grant
  capabilities.
