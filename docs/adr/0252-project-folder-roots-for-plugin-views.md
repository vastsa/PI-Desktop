# ADR 0252: Expose a Project's Folder Roots and Complete References Across Them

- **Status**: Accepted
- **Date**: 2026-09-14 (amends [ADR 0251](0251-chat-file-refs-open-in-the-file-view.md))
- **Related**: [ADR 0016](0016-sidebar-organization-and-multi-project-tabs.md) ·
  [ADR 0233](0233-renderer-owned-multi-folder-project-creation.md) ·
  [ADR 0241](0241-vendored-updatable-file-view-plugin.md) ·
  [ADR 0249](0249-chatgpt-style-logical-project-groups.md) ·
  [07-plugins/03-plugin-api](../spec/07-plugins/03-plugin-api.md)

## Context

ADR 0249 made a project a host-owned logical group: a display name, an ordered
list of local folder roots, and a primary root. Two of its clauses matter here.
The host keeps the **primary root as the one visible workspace** for builtin file
tools, and a tool request using an absolute path under **another registered
group root** is canonicalized and may use that root as its containment base.
Group membership never grants arbitrary filesystem access.

Nothing of that reached a plugin. `pi.workspace.get()` returned
`{ path, name }` — the primary root and its leaf name — and main filled it from
the single active workspace. So a contributed view could not learn that its
project had other folders at all.

ADR 0251 then made a chat file reference open in the bundled file view, and
handed it a **project-root-relative** path. With one folder that is
unambiguous. With a group it is not: `src/a.ts` does not say which folder it
belongs to, and the view's own containment base was the workspace root, so a
reference that resolved into a sibling folder could only be opened as an
external file — outside the tree, unhighlighted, and with the jail bypassed for
a file that is in fact part of the project.

## Decision

1. **`pi.workspace.get()` gains `projectId` and `roots`.** `path` and `name` keep
   their meaning — the primary root and its leaf name — so every existing plugin,
   including the file view shipped today, behaves exactly as before. `roots` is
   `{ path, name, primary }[]` in group order, primary first. The
   `workspace:changed` event carries the same object. This is project metadata
   the sidebar already shows, so it needs no new permission and no new method.
2. **Main answers from a snapshot of the group records.** host-core owns them;
   main keeps a copy so the synchronous `workspace:changed` broadcast and the
   asynchronous pull cannot disagree. The one authoritative list call
   (`project.groups.list`) fills it, every group mutation refreshes it, and a
   cold snapshot is fetched once on the first workspace of a run before the
   event is repeated with the folders.
3. **Completion searches the whole project.** `fs.resolveRef` walks the group's
   folders — primary first, then the group's own order — before the session
   scratch store, exactly as it walked the single workspace before. The first
   root that answers still wins outright, and the match now names the folder it
   answered from.
4. **The address shape follows the folder.** A match in the primary root travels
   as a project-relative path, byte-identical to ADR 0251. A match in any sibling
   folder travels as an **absolute** path — the shape scratch and attachment
   files already use — which the file view maps back to the folder that contains
   it. This keeps the payload a single opaque string, so no view contract changes
   and no new field has to be understood by a plugin that does not care.
5. **The host file tab reaches the group too.** Its extra containment roots gain
   the project's other folders, which ADR 0249 §5 already sanctions, so a
   reference that resolves into a sibling folder still opens when the file view
   is absent or disabled instead of failing containment.
6. **The file view's own jail base becomes the selected folder.** Its reads,
   writes, listing and search stay confined to one registered root at a time —
   never the whole group — with the same symlink and junction refusals and the
   same credential deny list. Which folder that is, and remembering it per
   project, is the view's own business.
7. **The switch is plugin-local.** Choosing another folder changes what that view
   browses. It does not change the app's visible workspace, the agent's tool
   roots, a session's primary path, project instructions or project memory.
   ADR 0249's one-visible-workspace model is untouched.

## Consequences

- A short reference now resolves anywhere in the project, and the view that opens
  it can show the file in its own folder rather than as an external file.
- A multi-folder project can be browsed folder by folder in the work panel,
  remembered per project, without the user changing what the agent works on.
- The container model, the permission model and the session model do not change:
  no new permission, no new IPC capability for plugins, one containment base at a
  time.
- A plugin that ignores `roots` keeps working; a host that cannot resolve a group
  sends the original payload and the view falls back to single-root behaviour, so
  the feature degrades rather than breaking.
- `fs.resolveRef` now has a wider notion of "the project". A project group is a
  user-authored list, so completion can reach folders the user added deliberately
  and nothing else.

## Alternatives considered

### Let the renderer push the group into the view payload

Rejected: a view also loads from the launcher with no chat reference at all, and
`location` is a one-shot subject, not metadata a long-lived view can rely on.

### Add a `pi.project.roots()` method instead of extending `workspace.get()`

Rejected: `workspace.get` is already where a plugin learns which root it is
working in. Two methods answering the same question would drift, and the
additive fields cost nothing to a plugin that ignores them.

### Run completion against every group folder with equal weight

Rejected: the primary root is the folder the agent's tools default to, so it
should answer first; the group's order then ranks the rest. An exact absolute
reference still outranks every shorthand, so nothing about this hides a real hit.

### Make the folder switch activate that folder as the workspace

Rejected: it would move the agent's tool roots, a session's primary path and the
project's instructions, which is exactly the multi-root execution ADR 0233 and
ADR 0249 refused. The user asked for a file browser that can look at the project's
other folders, not for the project to change underneath the conversation.

### Widen the bundled view's declared `fs` root to the whole group

Rejected: the manifest's root model is one directory, and widening it would give
the view standing access to every folder of every project rather than to the one
the user is looking at. One containment base at a time is the narrower grant and
is what the view already does.
