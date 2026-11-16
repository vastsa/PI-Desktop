# ADR 0263: Expose a Project's Folder Roots and Complete References Across Them

- Status: Accepted
- Date: 2026-09-14 (amends [ADR 0262](0262-chat-file-refs-open-in-the-file-view.md))
- Related: [ADR 0016](0016-sidebar-organization-and-multi-project-tabs.md) ·
  [ADR 0233](0233-renderer-owned-multi-folder-project-creation.md) ·
  [ADR 0241](0241-vendored-updatable-file-view-plugin.md) ·
  [ADR 0249](0249-chatgpt-style-logical-project-groups.md) ·
  [07-plugins/03-plugin-api](../spec/07-plugins/03-plugin-api.md)

## Context

ADR 0249 made a project a host-owned logical group with an ordered list of local
folder roots and a primary root that stays the visible workspace. None of that
reached a plugin: `pi.workspace.get()` returned only `{ path, name }` for the visible
workspace, so a contributed view could not learn that its project had other folders.
After ADR 0262 a chat file reference opened as a project-root-relative path, which is
ambiguous in a group, so a reference resolving into a sibling folder could only open
as an external file with the jail bypassed.

## Decision

1. **`pi.workspace.get()` gains `projectId` and `roots`.** `path` and `name` keep their
   meaning, `roots` is `{ path, name, primary }[]` in group order with the primary
   first, and `workspace:changed` carries the same object. This is project metadata the
   sidebar already shows, so it needs no new permission and no new method.
2. **Main answers from a snapshot of the group records.** The authoritative
   `project.groups.list` call fills it and every group mutation refreshes it, so the
   synchronous broadcast and asynchronous pull cannot disagree.
3. **Completion searches the whole project.** `fs.resolveRef` walks the group's
   folders, primary first and then group order, before the session scratch store, and
   the first root that answers wins outright.
4. **The address shape follows the folder.** A primary-root match travels as a
   project-relative path, while a sibling-folder match travels as an absolute path, the
   shape scratch and attachment files already use, so the payload stays one opaque
   string.
5. **The host file tab reaches the group too**, gaining the project's other folders as
   containment roots under ADR 0249 §5.
6. **The file view's jail base becomes the selected folder.** Reads, writes, listing,
   and search stay confined to one registered root at a time, never the whole group,
   with the same symlink refusals and credential deny list.
7. **The switch is plugin-local.** Choosing another folder changes only what that view
   browses, not the visible workspace, the agent's tool roots, a session's primary path,
   project instructions, or project memory.

## Consequences

- A short reference resolves anywhere in the project and opens in its own folder
  instead of as an external file.
- A multi-folder project can be browsed folder by folder in the work panel, remembered
  per project, without changing what the agent works on.
- The container, permission, and session models are unchanged, and a plugin that
  ignores `roots` keeps working because a host that cannot resolve a group sends the
  original payload.

## Alternatives

- Let the renderer push the group into the view payload — rejected: a view also loads
  with no chat reference, and `location` is a one-shot subject.
- Make the folder switch activate that folder as the workspace — rejected: it would
  move the agent's tool roots and the session's primary path.
