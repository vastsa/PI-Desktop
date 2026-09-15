# ADR 0251: Chat File References Complete in Main and Open in the File View

- **Status**: Accepted
- **Date**: 2026-09-14
- **Related**: [ADR 0104](0104-plugin-contributed-work-panel-views.md) ·
  [ADR 0124](0124-temporary-session-scratch-workspace.md) ·
  [ADR 0163](0163-transcript-file-reference-chips.md) ·
  [ADR 0241](0241-vendored-updatable-file-view-plugin.md) ·
  [04-ux/09-interaction-patterns](../spec/04-ux/09-interaction-patterns.md)

## Context

ADR 0163 made a file reference in the transcript clickable, but the click
trusted the token as written. An agent that works on
`/root/dir/openimage.js` routinely names only `openimage.js` in its reply, so
the reference resolved against the workspace root, pointed at a path that does
not exist, and the work panel painted an empty state — or, for a `.html` token,
opened a blank page in the side browser. Nothing told the user which of the two
had happened: a stale reference and a slow load looked the same.

The same click also chose the wrong surface. Every file went to the host
`file:` tab, a read-only viewer, while the work panel's capable file surface is
the vendored `pi.file-manager` view (ADR 0241) — which can edit, preview
images, media, CSV, JSON and SQLite, and which a user can already open from the
launcher. It had no way to be told *which* file to show: ADR 0104 gives a
contributed view a manifest entry and nothing else, and the `location` field a
work-panel tab already carries was honoured by main for `pi.browser` only.

## Decision

1. **Completion runs in Electron main**, as `fs.resolveRef`, because only main
   sees both the open project and the session's own scratch store
   (`<data_dir>/scratch/<sessionId>/`, ADR 0124). The order is a product
   contract, not an implementation detail:
   - an absolute reference that already names a real file inside a known root
     wins outright — that is path equality, not a guess;
   - an `attachments/<sha256>` blob names a stored file by hash, so it resolves
     against the attachment store directly;
   - otherwise the roots are searched in priority order — **the open project
     first, the session scratch store second, the attachment store last** — and
     the first root that answers wins, so the project is searched to exhaustion
     before the scratch store is considered;
   - inside one root, an exact path beats a shorthand; among shorthands the
     longest matching tail wins, then the shallowest path, so `src/dir/a.ts`
     beats a second `dir/a.ts` buried deeper;
   - the files panel's ignore set applies, so a dependency tree is never
     searched;
   - a reference that matches nothing opens **nothing** and reports itself. No
     empty panel, no blank browser page.
2. **The destination follows where the reference resolved.** A project file
   opens in the `pi.file-manager` view. A file in the session scratch or
   attachment store opens in the host `file:` tab, because it lives outside that
   view's project root — see point 4. A workspace `.html` / `.htm` file still
   opens in the side browser (ADR 0163), for an agent reply and a user chip
   alike: it is a page to run, not a file to read. When the file view is not
   loaded, a project file falls back to the host `file:` tab, so the click never
   regresses to nothing.
3. **A contributed view's `location` stops being browser-only.** It travels as
   the view entry URL's `piViewOpen` query parameter on creation — the only
   channel that cannot race a document that has not run yet — and as the
   `view:open` preload event once the document has loaded, through the same
   channel every other panel event uses. A location that arrives before the
   first `did-finish-load` restarts the load instead. A loaded view is never
   navigated: a plugin may hold unsaved edits, and a chat click must not discard
   them. Re-opening the same location does nothing. The payload is opaque to the
   host; each plugin decides what it means. No new permission, no new SDK
   method, no host-only capability.
4. **The view decides its own presentation.** `pi.file-manager` v0.4.0 opens the
   requested file, expands its ancestors, and collapses its own left file list
   for a host request — a new persisted state with a keyboard-reachable header
   toggle, so the stored split width comes back when it is expanded again. An
   absolute path outside the project root is treated as an explicitly
   host-chosen file: raw Node `fs`, with the credential deny list still applied
   to the raw, the normalized and the `realpath` form, and no root containment.
   This is deliberate and is why the plugin's `safetyNotes` states the exception
   instead of claiming the project-root containment still covers everything it
   reads.
5. **The bundled copy moves to v0.4.0** through ADR 0241's re-sync procedure, and
   the same release is published to the plugin center: the marketplace and the
   bundled copy ship the same bytes.

## Consequences

- A click on a shorthand lands on the file the agent meant, or says that nothing
  matched. The two failure modes ADR 0163 left indistinguishable are now
  distinguishable.
- The transcript's file surface is the same editable view the launcher offers,
  so "show me that file" and "let me change it" are one surface.
- The host now depends on a plugin version for a chat affordance. The fallback
  in point 2 bounds that dependency: an absent, disabled or older view degrades
  to the surface the click used before.
- The file view is no longer confined to the project root whenever, and only
  when, the host asks it for a path the host itself picked. A defect in that
  path handling is not caught by the host gateway; that is the same trust
  position ADR 0241 already took, extended by one explicitly-named case.
- A chat click no longer hands a file to the OS default application. That action
  is still reachable from the file view's own context menu.
- `fs.resolveRef` is a new renderer-facing channel. `fs/open` (ADR 0163) remains
  part of the IPC surface; the transcript is simply no longer one of its
  callers.

## Alternatives considered

### Resolve the shorthand in the renderer

Rejected: the renderer cannot see the session scratch store, and the two roots
have to be ranked against each other in one place for the priority order in
point 1 to hold.

### Add an `ui.openView(pluginId, viewId, payload)` SDK method

Rejected for now: the work-panel tab already carries `location`, and
`PluginViewHost.broadcast` already reaches docked views, so the feature needs no
new public API surface. A method that opened *another* plugin's view for a
plugin author would be a different decision, with its own consent question.

### Reload the view with the new location

Rejected: it discards whatever a plugin is holding, including unsaved edits.
The one reload in point 3 happens only before the first document has run, where
there is nothing to lose.

### Widen the plugin's declared `fs` root to the scratch store

Rejected: the manifest's root model is `workspace` or a user-selected directory.
Widening it would grant every project's view the right to read every session's
scratch data, which is a much larger grant than "the host asked for this one
file".

### Route workspace HTML through the file view for agent replies

Rejected: the file view renders a page as source. ADR 0163 chose the browser for
the same reason, and one contract is easier to reason about than two.

### Keep the OS default application as the destination

Rejected: it is not the right panel, and it is what the request replaces. The
action survives in the file view's context menu, which is where the file is
already on screen.
