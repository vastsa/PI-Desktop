# ADR 0264: Host-Mediated File Actions Follow the Folder a View Is Browsing

- Status: Accepted (amends [ADR 0263](0263-project-folder-roots-for-plugin-views.md))
- Date: 2026-09-15
- Related: ADR 0241, ADR 0249, ADR 0263

## Context

ADR 0263 §6 let a contributed view browse one folder of a multi-folder project at a
time, but said nothing about the two host-mediated actions a view cannot perform
itself — `fs.openDefault` and `fs.reveal` — which both resolve a workspace-relative
path against the workspace root (ADR 0241). Once a view can select a sibling folder
that contract silently opens or reports missing the wrong file, because the entry
list is relative to the *selected* folder.

## Decision

1. A view addresses a file by an absolute path when the selected folder is not the
   primary one; a relative path keeps meaning the workspace root, so the
   primary-folder case is unchanged, matching ADR 0263 §4.
2. `fs.openDefault` and `fs.reveal` accept an absolute path inside any registered
   folder root of the open project, and that root becomes the containment base, as
   ADR 0249 §5 already sanctions for tool requests.
3. The widening is limited to these two actions, which hand a path to the OS and
   return no file content: every other fs mode keeps the workspace root, and a plugin
   whose declared root is `userSelected` stays bound to the directory the user chose.
4. The request still needs the declared `fs.read`, a path outside the declared scope
   is refused rather than consented, credential and repository internals are refused
   as under the workspace root, and containment resolves through links.
5. When a view's open file closes, on a folder switch or otherwise, its editor buffer
   is cleared rather than hidden.

## Consequences

- Opening or revealing a file reaches the file the user right-clicked in the folder
  they are browsing.
- The group grant stays a user-authored list: no plugin can walk to an unregistered
  folder or read a file it could not read before.
- Editing remains the plugin's own business under its own jail (ADR 0241).

## Alternatives

- Widen the plugin's whole `fs` root to the selected folder: the host does not know
  which folder a view browses (ADR 0263 §6).
- Resolve the action inside the plugin process: the host owns the decision and the
  audit.
