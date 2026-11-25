# ADR 0241: Ship the file view as a vendored, updatable plugin

- Status: Accepted (supersedes ADR 0105; issue #304)
- Date: 2026-09-13
- Related: [ADR 0104](0104-plugin-contributed-work-panel-views.md) ·
  [ADR 0109](0109-open-files-with-the-os-associated-application.md) ·
  [ADR 0111](0111-reveal-files-in-file-manager.md) ·
  [ADR 0169](0169-classified-file-preview-and-live-workspace-events.md) ·
  [07-plugins/07-plugin-marketplace](../spec/07-plugins/07-plugin-marketplace.md)

## Context

The bundled `pi.files` view (ADR 0105) could only browse and preview the
workspace, so anything beyond looking at a file meant leaving the app.
`pi.file-manager` already covers editing and the image, CSV, JSON, and SQLite
surfaces as a third-party plugin on the same public channel — `contributes.views`,
a sandboxed page over `pluginBridge`, `ui.view` plus `fs.read` on root
`workspace` with scope `**` — and is published in the official marketplace.
Vendoring it raises two questions: how its writes are mediated, and how the
in-app copy stays consistent with the published one.

## Decision

1. The bundled file view is `pi.file-manager`, vendored into
   `apps/desktop/resources/plugins/` as the upstream release's own artifacts byte
   for byte plus a `license` manifest field, with `UPSTREAM.md` recording
   repository, tag, commit, and checksums; `pi.files` is removed and a build that
   stops shipping a plugin leaves no orphan registry row (ADR 0104).
2. It declares only `ui.view` and `fs.read` on root `workspace` with scope `**`,
   the same permissions the replaced view declared, and reaches the host only
   through the public bridge.
3. Editing writes are the plugin's own: its host process keeps the path jail,
   atomic writes, `mtime` and size conflict detection, and the write audit, none
   of which the host gateway mediates. A manifest cannot express a whole-tree
   write and this host does not sandbox a plugin process's `fs` access anyway, so
   bundling grants no capability a third-party plugin lacks; the boundary is
   stated in the manifest's `safetyNotes`.
4. Bundled means default and non-removable, not frozen: `sync_builtin` keeps an
   installed row whose source is not `builtin` while this build ships no strictly
   newer version, and `uninstall` refuses by id against the set of plugins this
   build ships, rebuilt from disk on every launch.
5. A catalog version is offered as an update only when it is strictly newer; a
   panel title comes from the manifest's localized title like any plugin, with no
   renderer label and no hardcoded view id.

## Consequences

- Upstream releases, not the application release cycle, decide when the file
  surface improves, and users can take them without an app update.
- `UPSTREAM.md` and the bundled-plugin test pin the vendored release, so a
  silent edit or half-done re-sync fails the build.
- "Cannot be uninstalled" is separate from "came from `resources/plugins`":
  `PluginSummary.bundled` carries that distinction, so `source == "builtin"` no
  longer answers whether a plugin is protected, and the bundled view's
  filesystem reach is the plugin's own.

## Alternatives considered

- Reimplement the viewers and editing in `pi.files`: it duplicates a maintained
  third-party plugin and keeps a large surface in the host.
- Bundle it read-only and leave editing to the marketplace copy: one plugin
  cannot offer two capability levels without forking it.
