# ADR 0331: Plugin session follow and host-owned work-panel reveal

- Status: Accepted
- Date: 2026-10-18
- Related: [ADR 0104](0104-plugin-contributed-work-panel-views.md) ·
  [ADR 0263](0263-project-folder-roots-for-plugin-views.md) ·
  [ADR 0330](0330-open-html-files-in-work-panel-browser-from-plugins.md)

## Context

Plugins that follow the conversation — a diff view, a running-task overlay, a
panel reacting to the selected session — need three facts the public API did not
expose: which session the user is looking at, which host turn it is running, and
how to show the plugin's own view beside it. Importing host internals is refused
by the packaging check as dynamic module loading, and host-store access is the
boundary the plugin SDK exists to keep.

## Decision

### 1. A bounded active-session snapshot

Add the additive `pi.session.getActive(): Promise<PluginActiveSession | null>`
with `{ sessionId, projectPath, activeTurn: { turnId, startedAt } | null }`,
delivered on `session:activated` whenever that snapshot changes; it takes no
session id and needs no permission because it reports what the shell shows.

### 2. Two owners assemble the snapshot

The renderer pushes its selection and the session's project path over a dedicated
IPC invoke, while the main process dates turn start from the existing
`recordTurnStart` seam and validates every reported turn id against `activeTurns`
before publishing, so a turn that ended without notice ages out.

### 3. A host-owned reveal

Add the additive `pi.ui.revealView({ viewId?, location?, sessionId? })` requiring
`ui.view`, which resolves the plugin's own `contributes.views`, caps the location,
compares `sessionId` with the active session, and reuses the existing `piViewOpen`
/ `view:open` transport so a live view is never reloaded.

### 4. Both are exposed on the panel bridge

`session.getActive` and `ui.revealView` let a docked view read the same snapshot
and reveal itself.

### 5. Nothing else changes

No host-core protocol, persisted data, manifest schema, or permission list
changes, and older hosts reject the new calls with `UNSUPPORTED`.

## Consequences

- A plugin can follow the selected session and open its own view beside it
  without touching host internals, so such plugins are publishable again.
- A plugin cannot address a session the user is not looking at, and a reveal for
  a session the user left is refused instead of opening an unseen tab.
- The snapshot is a value rather than a subscription: a missed event is repaired
  by one `getActive()` call, at the cost of one more IPC hop per switch.

## Alternatives considered

- Expose the renderer store to `renderer.extension` plugins: rejected; it makes
  host internals a contract with no permission boundary.
- Let the plugin infer the selection from `session.list` and turn events:
  rejected; it exposes other sessions and produced the wrong-turn overlay this
  change removes.
