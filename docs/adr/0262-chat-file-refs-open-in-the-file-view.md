# ADR 0262: Chat File References Complete in Main and Open in the File View

- **Status**: Accepted
- **Date**: 2026-09-14
- **Related**: [ADR 0104](0104-plugin-contributed-work-panel-views.md) ·
  [ADR 0124](0124-temporary-session-scratch-workspace.md) ·
  [ADR 0163](0163-transcript-file-reference-chips.md) ·
  [ADR 0241](0241-vendored-updatable-file-view-plugin.md) ·
  [04-ux/09-interaction-patterns](../spec/04-ux/09-interaction-patterns.md)

## Context

ADR 0163 made transcript file references clickable but trusted the token as
written, so an agent naming only `openimage.js` resolved at the workspace root and
painted an empty panel or a blank browser page, indistinguishable from a slow
load. The click also always chose the host `file:` tab, while the panel's capable
surface is the vendored `pi.file-manager` view (ADR 0241), which had no way to be
told which file to show.

## Decision

1. **Completion runs in Electron main** as `fs.resolveRef`, because only main sees
   the open project and the session scratch store
   (`<data_dir>/scratch/<sessionId>/`, ADR 0124). An absolute reference naming a
   real file inside a known root wins outright; an `attachments/<sha256>` blob
   resolves against the attachment store; otherwise roots are searched in priority
   order — **open project, session scratch, attachment store** — with the project
   exhausted before the scratch store is considered. Inside one root an exact path
   beats a shorthand, which resolves only when its complete supplied suffix
   uniquely identifies one safe file: it never degrades, ambiguous matches resolve
   to nothing, the files-panel ignore set applies, and a reference that matches
   nothing opens **nothing** and reports itself.
2. **The destination follows where the reference resolved.** A project file opens
   in `pi.file-manager`, except a positioned reference (`:line`, `:line:column`,
   `:line-range`, `#Lline[-Lend]`), which opens in the host's read-only `file:` tab
   so the requested source line can be shown — the bundled view has no
   line-navigation contract. Scratch and attachment files open in the host `file:`
   tab because they live outside that view's project root. An unpositioned
   `.html` / `.htm` file in the session's project group or own scratch directory
   opens in the side browser (ADR 0163), with browser roots resolved from the
   owning session. A direct user click on a project file actively ensures the
   bundled view runs — enabling an off plugin or reloading one with no contributed
   view — without restoring a missing `ui.view` grant or widening project scope;
   if either boundary excludes the project, or the plugin still cannot start, the
   host `file:` tab opens with a notice.
3. **A contributed view's `location` stops being browser-only.** It travels as the
   view entry URL's `piViewOpen` query parameter on creation and as the `view:open`
   preload event after load. A location that arrives before the first
   `did-finish-load` restarts the load; a loaded view is never navigated, because a
   plugin may hold unsaved edits, and re-opening the same location does nothing.
   The payload is opaque to the host, and no permission or SDK method is added.
4. **The view decides its own presentation.** `pi.file-manager` v0.4.0 opens the
   requested file, expands its ancestors, and collapses its left file list for a
   host request. An absolute path outside the project root is treated as an
   explicitly host-chosen file: raw Node `fs` with the credential deny list applied
   to the raw, normalized and `realpath` forms and no root containment, which its
   `safetyNotes` states. ADR 0339 drops root containment for the host as well:
   `fs/resolveRef`, `fs/read`, `fs/reveal`, and `fs/open` open an exact absolute
   path outside managed roots. The host applies no deny list because it only shows
   the file to the user who clicked it, while the plugin keeps its own.
5. **The bundled copy moves to v0.4.0** through ADR 0241's re-sync procedure and
   ships the same bytes as the plugin-center release.

## Consequences

- A shorthand lands on the file the agent meant, or says that nothing matched, so
  the two failure modes ADR 0163 left indistinguishable are distinguishable.
- The transcript's file surface is the same editable view the launcher offers; the
  host now depends on a plugin version for a chat affordance and degrades to the
  host `file:` tab with a notice when the plugin cannot start.
- The view is unconfined to the project root only when the host asks for a path it
  picked itself, extending ADR 0241's trust position by one named case.
- A chat click no longer hands a file to the OS default application, which remains
  in the file view's context menu. `fs.resolveRef` is a new renderer-facing channel
  while `fs/open` (ADR 0163) stays on the IPC surface.

## Alternatives

- Resolve the shorthand in the renderer: rejected, it cannot see the scratch store
  and both roots must be ranked in one place.
- Add a `ui.openView(pluginId, viewId, payload)` SDK method: rejected, the tab
  already carries `location` and no new public API is needed.
- Reload the view with the new location: rejected, it discards plugin state.
- Widen the plugin's declared `fs` root to the scratch store: rejected, it would
  grant every project access to every session's scratch data.
- Route workspace HTML through the file view: rejected, it renders a page as source.
- Keep the OS default application as the destination: rejected, it is not the panel.
