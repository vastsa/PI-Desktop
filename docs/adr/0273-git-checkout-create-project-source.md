# ADR 0273: Git Checkout as a Create Project Source

- Status: Accepted for implementation (amends ADR 0233, ADR 0247)
- Date: 2026-09-17

## Context

ADR 0233 gave the renderer one Create project surface (name plus local folders), and
the home switcher already cloned through `project/clone` under ADR 0247's public-host
rules, but that switcher only renders inside the hero of a project-bound session, so a
fresh installation needed a local folder before any clone entry existed.

## Decision

The Create project dialog owns a source selector with two equal peers, This computer
and Git repository, where the git source keeps the single name field, adds a
repository URL and one clone destination row, and parses the URL with the same
`parseGitCloneUrl` rules as the home switcher. Main exposes additive
`project/cloneCheckout({ url, parentPath })`, which clones into an explicit parent
folder and returns `{ path, name }` without touching the active workspace, and
creation still flows through `project-group/create` so a checkout becomes the primary
root of one logical group, exactly like a folder pick. `project/clone` keeps its
behavior for the home switcher.

## Consequences

- A fresh installation can create its first project from a public repository, and the
  destination is explicit before `git clone` runs.
- Private, loopback, link-local, credential-bearing, and malformed remotes stay
  rejected before git runs (ADR 0247).
- A failed group creation leaves the folder on disk for a retry, and no protocol,
  schema, host RPC, or storage change is needed.

## Alternatives

- Reuse `project/clone` in the dialog: it activates a project before the group exists.
- Let main pick the destination silently: a clone should never choose its own folder.
