# ADR 0331: Plugin session follow and host-owned work-panel reveal

- Status: Accepted
- Date: 2026-10-18
- Deciders: PI-Desktop maintainers
- Related: [ADR 0104](0104-plugin-contributed-work-panel-views.md) ·
  [ADR 0263](0263-project-folder-roots-for-plugin-views.md) ·
  [ADR 0330](0330-open-html-files-in-work-panel-browser-from-plugins.md) ·
  [07-plugins/03-plugin-api](../spec/07-plugins/03-plugin-api.md)

## Context

Plugins that follow the conversation — a diff view, a running-task overlay, a
side panel that reacts to the selected session — need three facts the public API
did not expose: which session the user is looking at, which host turn that
session is running, and how to show the plugin's own view beside that session.

The only way to obtain them was to import the host's internal modules from a
plugin renderer entry, which the packaging check refuses as dynamic module
loading (`renderer/index.mjs:466: dynamic or remote code execution`). The
plugin then cannot be published at all, and the workaround a plugin author
reaches for next is host-store access, which is exactly the boundary the
plugin SDK exists to keep.

The host already had every piece internally: the renderer owns the selection,
the main process owns `activeTurns`, and the work panel owns one tab set per
session. `session:activated` was already documented as a planned event.

## Decision

1. Add the additive `pi.session.getActive(): Promise<PluginActiveSession | null>`
   with `{ sessionId, projectPath, activeTurn: { turnId, startedAt } | null }`,
   and deliver the same payload on the `session:activated` event whenever that
   snapshot changes. It takes no session id and needs no new permission: it
   reports what the shell already shows, exactly as `workspace.get` reports the
   open folder.
2. Assemble the snapshot from two owners rather than one. The renderer pushes
   its selection and the session's project path over a dedicated IPC invoke; the
   main process dates the turn start from the same `recordTurnStart` seam that
   already records durable turn identity, and validates every reported turn id
   against `activeTurns` before publishing it. A turn that ended without notice
   therefore ages out instead of pinning a stale "running" state.
3. Add the additive `pi.ui.revealView({ viewId?, location?, sessionId? })`
   requiring `ui.view`. It resolves the plugin's own `contributes.views`,
   caps the location, and compares `sessionId` with the active session before
   Electron Main asks the renderer to open that session's tab. Reuse the
   existing `piViewOpen` / `view:open` location transport, so a live view is
   never reloaded.
4. Expose both on the panel bridge as `session.getActive` and `ui.revealView`,
   so a docked view reads the same snapshot and reveals itself.
5. No host-core protocol, persisted data, manifest schema, or permission list
   changes. Older hosts reject the new calls with `UNSUPPORTED`, which is what a
   plugin already has to handle.

## Consequences

- A plugin can follow the selected session, name its running turn, and open its
  own view beside that session without touching host internals, which makes
  such plugins publishable again.
- The selection stays shell-owned: a plugin cannot address a session the user
  is not looking at, and a reveal naming a session the user left is refused
  instead of opening a tab nobody sees.
- The snapshot is a value, not a subscription handle. A plugin compares
  `sessionId` instead of assuming the session still holds, and a missed event
  is repaired by one `getActive()` call.
- Session selection now crosses one more IPC hop on every switch. The push is
  idempotent and deduplicated before any plugin is told, so an unchanged
  snapshot costs one invoke and no event.

## Alternatives considered

### Expose the renderer store to `renderer.extension` plugins

Rejected: it makes host internals a contract, has no permission boundary, and
would freeze every store refactor.

### Let the plugin read `pi.session.list` and infer the selection

Rejected: it exposes sessions the user is not looking at, and `session.list` is
scoped to plugin-owned sessions; inference from `session:turnEnded` and draft
changes is what produced the wrong-turn overlay this ADR removes.

### A separate `session:turnStarted` event

Rejected: the snapshot already carries the turn, so a second event would give
plugins two ways to learn one fact and two chances to disagree.
