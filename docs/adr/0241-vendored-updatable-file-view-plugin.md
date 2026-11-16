# ADR 0241: Ship the file view as a vendored, updatable plugin

- Status: Accepted (supersedes ADR 0105; issue #304)
- Date: 2026-09-13
- Deciders: PI-Desktop core
- Related: [ADR 0104](0104-plugin-contributed-work-panel-views.md) ·
  [ADR 0105](0105-files-as-a-bundled-plugin.md) ·
  [ADR 0109](0109-open-files-with-the-os-associated-application.md) ·
  [ADR 0111](0111-reveal-files-in-file-manager.md) ·
  [ADR 0169](0169-classified-file-preview-and-live-workspace-events.md) ·
  [07-plugins/07-plugin-marketplace](../spec/07-plugins/07-plugin-marketplace.md)

## Context

The bundled `pi.files` view (ADR 0105) browsed and previewed the workspace and
nothing else: no editing, no image, CSV, JSON, or SQLite surface, and a line cap
on text preview. Anything more than looking at a file meant leaving the app.

## Decision

1. The bundled file view is `pi.file-manager`, vendored into
   `apps/desktop/resources/plugins/`.
2. It declares only `ui.view` and `fs.read` (`root: workspace`, `scope: ["**"]`)
   — the same permissions the view it replaces declared.**
3. Editing writes are the plugin's own: its host process keeps the path jail,
   atomic writes, `mtime`/size conflict detection, and the write audit.
4. **Bundled means default and non-removable, not frozen.** A bundled plugin
   cannot be uninstalled, but it can be updated from the marketplace, and that
   update survives the next launch:
   - `sync_builtin` keeps an installed row whose source is not `builtin` for as
     long as this build does not ship a *strictly newer* version.
   - `uninstall` refuses by id against the set of plugins this build ships,
     rebuilt from disk on every launch.
5. A catalog version is offered as an update only when it is strictly newer than
   what is installed.
6. The panel title is the manifest's localized title, as for any plugin.

## Consequences

- The work panel's file surface is a vendor copy, so the application's own
  release cycle no longer decides when the view improves; upstream releases do,
  and users can take them without waiting for an app update.
- Maintaining the copy is a deliberate act: `UPSTREAM.md` and
  `apps/desktop/test/bundled-plugins.test.mjs` pin the vendored release, so a
  silent edit or a half-done re-sync fails the build.
- "Cannot be uninstalled" is now separate from "came from `resources/plugins`".
- The marketplace keeps listing a bundled plugin and offers its updates.
- A plugin the user updated keeps a marketplace/`local` source while remaining
  bundled.

## Alternatives considered

### Reimplement the missing viewers and editing in `pi.files`

Rejected: it duplicates a maintained third-party plugin, and the line cap, media
viewers, structured viewers, and SQLite browsing are a large surface to keep in
the host.

### Bundle it read-only and leave editing to the marketplace copy

Rejected: the same plugin cannot offer two capability levels without forking it,
and a read-only default would leave the most common request — change this line —
unanswered.

### Let the bundled copy always win, with no updates

Rejected: a user could then only get a newer upstream release by updating the
application, which defeats the point of vendoring a published plugin.

### Hide the marketplace entry for a bundled id

Rejected: the entry is where a newer upstream release is published.
