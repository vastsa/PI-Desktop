# ADR 0348: A docked view may borrow the workbench layout

- Status: Accepted
- Date: 2026-11-19
- Related: [ADR 0104](0104-plugin-contributed-work-panel-views.md) ·
  [ADR 0224](0224-right-panel-tab-strip.md) · spec 07-plugins/02

## Context

ADR 0104 gave a plugin one docked surface inside the work panel, always as an
ordinary third column beside the sidebar and MainChat. Some contributed views
are not side panes: a novel workbench, an editor, or a document board needs the
center pane and as much horizontal room as the window has. Today that user
folds the sidebar and maximizes the panel by hand on every visit, and the plugin
cannot ask for it without reaching into host navigation, which the view
contract forbids.

The host already has both controls: the transient work-panel maximize
(`useAppShellRuntime`) and the collapsible left sidebar. Neither is persisted as
a temporary state, so lending them is reversible.

## Decision

1. **One optional manifest field.** `contributes.views[].presentation` accepts
   `"workbench"` and nothing else; omitting it keeps the current docked pane.
   An unknown value rejects the manifest in both the SDK validator and
   host-core, because the host acts on the value rather than passing it through.
2. **One new metadata field.** `PluginViewMeta` carries `presentation` only when
   the view declared it, so every existing consumer keeps its current payload
   shape and behavior. The main process copies it from the manifest beside the
   resolved title; no new IPC channel, permission, or host API is introduced.
3. **Eligibility is the foreground docked tab.** The layout applies only when
   the Chat page owns the center pane, the work panel is presented, and the
   active tab of the current session's own work panel context is an opted-in
   view. A background session, another page, a closed panel, or a different tab
   is the ordinary layout.
4. **Borrow, then give back.** Entering the activation sets the existing
   work-panel maximize and collapses the sidebar; leaving restores only the
   parts the layout changed. A panel the user had already maximized, or a
   sidebar the user had already collapsed, is left alone. Switching directly
   between two opted-in views (including across sessions) keeps the borrowed
   layout instead of restoring and re-applying it.
5. **The user wins while they are in the view.** A manual maximize toggle or a
   manual sidebar reopen clears that axis from the layout's ownership, so the
   transition only runs on activation changes: a re-render never re-maximizes,
   and the restore at leave time never overrides a manual restore.
6. **Nothing temporary is persisted.** The policy never writes the panel width
   or the sidebar width, so both columns return at the user's own preferred
   widths, and restoring the maximize brings back the ordinary resizable panel.

## Consequences

- A plugin gets a full-width working surface without a new capability: the
  opt-in is presentation only and stays behind `ui.view`.
- The behavior is host-owned and identical for every plugin; a plugin cannot
  choose a width, hide a control, or keep the layout after the user leaves.
- The policy is a pure reducer over activation keys, so the transitions are
  unit-tested without a renderer; the shell wires it to the existing state.
- Per-session work panel contexts remain the single source of "which tab is
  foreground": the policy reads the visible projection and adds no second one.
