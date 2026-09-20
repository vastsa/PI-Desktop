# ADR 0273: Git Checkout as a Create Project Source

- Status: Accepted for implementation
- Date: 2026-09-17
- Deciders: PI-Desktop desktop UI maintainers
- Amends: ADR 0233, ADR 0247

## Context

ADR 0233 gave the renderer one Create project surface that collects a name and
local folders, and the home switcher already cloned a git project through
`project/clone` under the public-host rules of ADR 0247. A user with no project
at all still could not start from a repository: the switcher only renders
inside the hero of a project-bound session, and the dialog had no repository
source. The first project of a fresh installation therefore required a local
folder before any clone entry was reachable.

The existing clone picks its parent through a native dialog and returns a
workspace the renderer activates immediately. Reusing it inside the dialog would
either end the dialog flow halfway or activate a project before its group
exists.

## Decision

1. The Create project dialog owns a source selector with two equal peers: This
   computer (local folders) and Git repository.
2. The git source keeps the dialog's one name field, adds a repository URL field
   and one clone destination row, and parses the URL in the renderer with the
   same `parseGitCloneUrl` rules the home switcher uses (ADR 0247).
3. Main exposes additive `project/cloneCheckout({ url, parentPath })`: it clones
   into an explicit parent folder and returns `{ path, name }` without touching
   the active workspace and without opening a picker.
4. Project creation still flows through `project-group/create`. A checkout
   becomes the primary root of one logical group and the entered name names the
   group, exactly like a folder pick (ADR 0233). Folder picks and checkouts
   share one creation helper in the project slice.
5. `project/clone` keeps its current behavior for the home switcher; the two
   clone entries do not share UI.

## Consequences

- A fresh installation can create its first project directly from a public
  repository without opening an unrelated folder first.
- The clone destination is explicit: the dialog collects it before `git clone`
  runs, so a checkout never lands in an implicit directory.
- Private, loopback, link-local, credential-bearing, and malformed remotes stay
  rejected before git runs (ADR 0247); the dialog disables Create for them.
- A checkout that succeeds while group creation fails leaves the cloned folder
  on disk; the error surfaces as a toast and the folder can be added afterwards.
- No protocol, schema, host RPC, or storage change: the new channel is a narrow
  main-process capability, and the host still owns every durable project record.

## Alternatives considered

- **Move the home switcher clone entry to the empty home:** rejected because the
  hero without a project-bound session has no switcher surface, and the create
  dialog is the documented first-project entry.
- **Reuse `project/clone` inside the dialog:** rejected because its native parent
  picker and immediate workspace return would activate a project before the group
  is created.
- **Let the main process pick the destination silently:** rejected because a
  `git clone` should never choose its own destination folder.
