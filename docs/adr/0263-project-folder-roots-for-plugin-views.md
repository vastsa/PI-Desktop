# ADR 0263: Expose a Project's Folder Roots and Complete References Across Them

- **Status**: Accepted
- **Date**: 2026-09-14 (amends [ADR 0262](0262-chat-file-refs-open-in-the-file-view.md))
- **Related**: [ADR 0016](0016-sidebar-organization-and-multi-project-tabs.md) ·
  [ADR 0233](0233-renderer-owned-multi-folder-project-creation.md) ·
  [ADR 0241](0241-vendored-updatable-file-view-plugin.md) ·
  [ADR 0249](0249-chatgpt-style-logical-project-groups.md) ·
  [07-plugins/03-plugin-api](../spec/07-plugins/03-plugin-api.md)

## Context

ADR 0249 made a project a host-owned logical group: a display name, an ordered
list of local folder roots, and a primary root. Two of its clauses matter here.

## Decision

1. **`pi.workspace.get()` gains `projectId` and `roots`.** `path` and `name`
   keep their meaning — the primary root and its leaf name — so every existing
   plugin, including the file view shipped today, behaves exactly as before.
2. **Main answers from a snapshot of the group records.** host-core owns them;
   main keeps a copy so the synchronous `workspace:changed` broadcast and the
   asynchronous pull cannot disagree.
3. **Completion searches the whole project.** `fs.resolveRef` walks the group's
   folders — primary first, then the group's own order — before the session
   scratch store, exactly as it walked the single workspace before.
4. **The address shape follows the folder.** A match in the primary root travels
   as a project-relative path, byte-identical to ADR 0262.
5. **The host file tab reaches the group too.** Its extra containment roots gain
   the project's other folders, which ADR 0249 §5 already sanctions, so a
   reference that resolves into a sibling folder still opens when the file view
   is absent or disabled instead of failing containment.
6. **The file view's own jail base becomes the selected folder.** Its reads,
   writes, listing and search stay confined to one registered root at a time —
   never the whole group — with the same symlink and junction refusals and the
   same credential deny list.
7. **The switch is plugin-local.** Choosing another folder changes what that
   view browses.

## Consequences

- A short reference now resolves anywhere in the project, and the view that
  opens it can show the file in its own folder rather than as an external file.
- A multi-folder project can be browsed folder by folder in the work panel,
  remembered per project, without the user changing what the agent works on.
- The container model, the permission model and the session model do not change:
  no new permission, no new IPC capability for plugins, one containment base at
  a time.
- A plugin that ignores `roots` keeps working; a host that cannot resolve a
  group sends the original payload and the view falls back to single-root
  behaviour, so the feature degrades rather than breaking.
- `fs.resolveRef` now has a wider notion of "the project".

## Alternatives considered

### Let the renderer push the group into the view payload

Rejected: a view also loads from the launcher with no chat reference at all, and
`location` is a one-shot subject, not metadata a long-lived view can rely on.

### Add a `pi.project.roots()` method instead of extending `workspace.get()`

Rejected: `workspace.get` is already where a plugin learns which root it is
working in.

### Run completion against every group folder with equal weight

Rejected: the primary root is the folder the agent's tools default to, so it
should answer first; the group's order then ranks the rest.

### Make the folder switch activate that folder as the workspace

Rejected: it would move the agent's tool roots, a session's primary path and the
project's instructions, which is exactly the multi-root execution ADR 0233 and
ADR 0249 refused.

### Widen the bundled view's declared `fs` root to the whole group

Rejected: the manifest's root model is one directory, and widening it would give
the view standing access to every folder of every project rather than to the one
the user is looking at.
