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

## Decision

1. Add the additive `pi.session.getActive(): Promise<PluginActiveSession |
   null>` with `{ sessionId, projectPath, activeTurn: { turnId, startedAt } |
   null }`, and deliver the same payload on the `session:activated` event
   whenever that snapshot changes.
2. Assemble the snapshot from two owners rather than one.
3. Add the additive `pi.ui.revealView({ viewId?, location?, sessionId? })`
   requiring `ui.view`.
4. Expose both on the panel bridge as `session.getActive` and `ui.revealView`,
   so a docked view reads the same snapshot and reveals itself.
5. No host-core protocol, persisted data, manifest schema, or permission list
   changes.

## Consequences

- A plugin can follow the selected session, name its running turn, and open its
  own view beside that session without touching host internals, which makes such
  plugins publishable again.
- The selection stays shell-owned: a plugin cannot address a session the user is
  not looking at, and a reveal naming a session the user left is refused instead
  of opening a tab nobody sees.
- The snapshot is a value, not a subscription handle.
- Session selection now crosses one more IPC hop on every switch.

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
