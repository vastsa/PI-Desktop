# ADR 0264: Host-Mediated File Actions Follow the Folder a View Is Browsing

- **Status**: Accepted
- **Date**: 2026-09-15 (amends [ADR 0263](0263-project-folder-roots-for-plugin-views.md))
- **Related**: [ADR 0241](0241-vendored-updatable-file-view-plugin.md) ·
  [ADR 0249](0249-chatgpt-style-logical-project-groups.md) ·
  [07-plugins/03-plugin-api](../spec/07-plugins/03-plugin-api.md)

## Context

ADR 0263 §6 let a contributed view browse one folder of a multi-folder project at
a time, and made the view responsible for remembering which one. It said nothing
about the two actions a view cannot perform itself: opening a file with the
system default application (`fs.openDefault`) and revealing it in the OS file
manager (`fs.reveal`). Both are host-mediated, and both were defined against the
**workspace root**: the request carries a workspace-relative path, and the host
resolves it there (ADR 0241, `plugin-runtime.ts` `resolveFsRequest`).

That contract was correct while the workspace root was also the only folder a
view could browse. Once the view can select a sibling folder it is not: the entry
list is relative to the *selected* folder, so a view that hands a relative path to
the host has it resolved against the primary folder instead. Two folders holding a
same-named file make that silent — opening `shared.txt` while browsing the second
folder opens the first folder's file — and a file only the second folder holds
reports not found. Both were reachable from the folder switcher.

## Decision

1. **A view addresses a file by an absolute path when the selected folder is not
   the primary one.** A relative path keeps meaning the workspace root, so the
   primary-folder case is unchanged, byte for byte. This is the same rule ADR 0263
   §4 already applies to chat file references: the address shape follows the folder
   that owns the file.
2. **`fs.openDefault` and `fs.reveal` accept an absolute path inside any registered
   folder root of the open project.** That root then becomes the containment base
   for the request, which ADR 0249 §5 already sanctions for tool requests. The
   relative form is matched against the declared scope of the folder that answered.
3. **The widening is limited to these two actions.** They hand a path to the OS and
   return no file content; every other fs mode keeps the workspace root, so no
   plugin gains byte access to another folder. A plugin whose declared root is
   `userSelected` is unaffected: its base stays the directory the user chose.
4. **The guards are the ones every other request passes.** The request still needs
   the declared `fs.read`; a path inside a project folder that the declared scope
   does not cover is refused rather than consented; credential and repository
   internals are refused exactly as under the workspace root; and containment is
   resolved through links, so a symlink or junction inside a registered folder
   cannot carry the request out of it.
5. **The end of a session is the end of its documents.** When a view's open file
   closes — on a folder switch, or any other close — its editor buffer is cleared,
   not merely hidden: the pane must not keep a document from a folder the user has
   left, and a stale buffer must never be what a later save or a same-named file
   in another folder meets.

## Consequences

- Opening or revealing a file behaves the same in every folder of a project: the
  action reaches the file the user right-clicked, in the folder they are browsing.
- The group grant stays a user-authored list. A plugin cannot walk to a folder the
  user did not register, and cannot read a file it could not read before.
- A view that ignores the rule (sends a relative path while browsing a sibling
  folder) still gets the old behaviour: it opens the primary folder's file. The
  contract for that case is therefore documented in the plugin API rather than left
  implicit.
- Editing a file remains the plugin's own business: its reads and writes still go
  through its own Node fs under its own jail (ADR 0241), and only these two
  mediated actions go through the host.

## Alternatives considered

### Widen the plugin's whole `fs` root to the selected folder

Rejected: the host does not know which folder a view is browsing — that choice is
plugin-local by design (ADR 0263 §6) — and a per-call base would let any plugin
claim another project folder for reading and writing, which is a grant ADR 0249 §5
deliberately tied to a user-visible tool request.

### Have the view send a path relative to the workspace root

Rejected: only computable when the sibling folder sits inside the primary one.
Sibling folders that are unrelated directories — the ordinary case for a project
group — have no such path, and inventing `../` forms is exactly the escape the
containment checks refuse.

### Resolve the action inside the plugin process

Rejected: the point of the host-mediated route is that the host owns the decision
and the audit. The plugin deliberately does not declare a shell or a system-open
capability, and it should not grow one for a file it is already displaying.

### Disable the two actions while a sibling folder is selected

Rejected: it turns a fixable addressing mistake into a missing feature. The user
who switched folders is looking at those files and expects the same context menu
to work on them.
