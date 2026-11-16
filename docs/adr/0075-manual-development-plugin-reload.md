# ADR 0075: Manual reload for development-plugin permission ceilings

- Status: Accepted
- Date: 2026-08-12

## Context

Development plugins are watched and hot-reloaded from their local folders. The
watcher intentionally refuses a manifest that adds permissions beyond the
ceiling approved when the folder was loaded.

## Decision

Add a renderer-to-main `pi-desktop/plugin/reload` invoke channel. Electron main
resolves the plugin id through the host registry, loads the registered path with
the registry's current permissions, and re-arms the development watcher after a
successful load.

The automatic watcher remains conservative: it cannot widen the permission
ceiling. A manual reload is an explicit developer action that acknowledges the
current manifest and makes its declared permissions the new ceiling for later
automatic reloads.

## Consequences

- Developers can recover from permission-gated hot reloads without re-picking a
  folder.
- Installed and marketplace plugins do not gain a manual reload control.
- The existing watcher, plugin runtime, and host-core storage contracts remain
  unchanged; the new channel is an additive Electron IPC surface.

## Alternatives considered

- Reusing the folder picker: rejected because it repeats path selection and
  makes recovery needlessly disruptive.
- Allowing automatic reloads to widen permissions: rejected because file edits
  must not silently grant new capabilities.
