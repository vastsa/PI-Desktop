# ADR 0262: Chat File References Complete in Main and Open in the File View

- **Status**: Accepted
- **Date**: 2026-09-14
- **Related**: [ADR 0104](0104-plugin-contributed-work-panel-views.md) ·
  [ADR 0124](0124-temporary-session-scratch-workspace.md) ·
  [ADR 0163](0163-transcript-file-reference-chips.md) ·
  [ADR 0241](0241-vendored-updatable-file-view-plugin.md) ·
  [04-ux/09-interaction-patterns](../spec/04-ux/09-interaction-patterns.md)

## Context

ADR 0163 made a file reference in the transcript clickable, but the click
trusted the token as written. An agent that works on `/root/dir/openimage.js`
routinely names only `openimage.js` in its reply, so the reference resolved
against the workspace root, pointed at a path that does not exist, and the work
panel painted an empty state — or, for a `.html` token, opened a blank page in
the side browser.

## Decision

1. **Completion runs in Electron main**, as `fs.resolveRef`, because only main
   sees both the open project and the session's own scratch store
   (`<data_dir>/scratch/<sessionId>/`, ADR 0124).
   - an absolute reference that already names a real file inside a known root
     wins outright — that is path equality, not a guess;
   - an `attachments/<sha256>` blob names a stored file by hash, so it resolves
     against the attachment store directly;
   - otherwise the roots are searched in priority order — **the open project
     first, the session scratch store second, the attachment store last** — and
     the first root that answers wins, so the project is searched to exhaustion
     before the scratch store is considered;
   - inside one root, an exact path beats a shorthand; a shorthand resolves only
     when its complete supplied suffix uniquely identifies one safe file.
   - the files panel's ignore set applies, so a dependency tree is never
     searched;
   - a reference that matches nothing opens **nothing** and reports itself.
2. **The destination follows where the reference resolved.** A project file
   opens in the `pi.file-manager` view, except a positioned reference (`:line`,
   `:line:column`, `:line-range` or `#Lline[-Lend]`), which opens in the host's
   read-only `file:` tab so the requested source line can be brought into view.
3. **A contributed view's `location` stops being browser-only.** It travels as
   the view entry URL's `piViewOpen` query parameter on creation — the only
   channel that cannot race a document that has not run yet — and as the
   `view:open` preload event once the document has loaded, through the same
   channel every other panel event uses.
4. **The view decides its own presentation.** `pi.file-manager` v0.4.0 opens the
   requested file, expands its ancestors, and collapses its own left file list
   for a host request — a new persisted state with a keyboard-reachable header
   toggle, so the stored split width comes back when it is expanded again.
5. **The bundled copy moves to v0.4.0** through ADR 0241's re-sync procedure,
   and the same release is published to the plugin center: the marketplace and
   the bundled copy ship the same bytes.

## Consequences

- A click on a shorthand lands on the file the agent meant, or says that nothing
  matched.
- The transcript's file surface is the same editable view the launcher offers,
  so "show me that file" and "let me change it" are one surface.
- The host now depends on a plugin version for a chat affordance.
- A direct project-file click can re-enable the bundled plugin, because the
  click is an explicit request to use it.
- The file view is no longer confined to the project root whenever, and only
  when, the host asks it for a path the host itself picked.

## Alternatives considered

### Resolve the shorthand in the renderer

Rejected: the renderer cannot see the session scratch store, and the two roots
have to be ranked against each other in one place for the priority order in
point 1 to hold.

### Add an `ui.openView(pluginId, viewId, payload)` SDK method

Rejected for now: the work-panel tab already carries `location`, and
`PluginViewHost.broadcast` already reaches docked views, so the feature needs no
new public API surface.

### Reload the view with the new location

Rejected: it discards whatever a plugin is holding, including unsaved edits.

### Widen the plugin's declared `fs` root to the scratch store

Rejected: the manifest's root model is `workspace` or a user-selected directory.

### Route workspace HTML through the file view for agent replies

Rejected: the file view renders a page as source.

### Keep the OS default application as the destination

Rejected: it is not the right panel, and it is what the request replaces.
