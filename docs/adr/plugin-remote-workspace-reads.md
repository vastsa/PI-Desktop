# ADR: Plugin reads in remote workspaces

## Status

Implemented candidate

## Context

Issue #1711 reports a File Manager that keeps loading in an SSH workspace. Remote
projects have an opaque Desktop identity, not a local filesystem root, and the
upstream plugin passes that identity to its own Node filesystem. Existing owner-only
`workspace/files` reads do not enforce a plugin's declared file scope, so forwarding
plugin requests there would widen their access.

## Decision

Extend `fs.list` and `fs.readPreview` with remote reads. Desktop admits each call
against the plugin permission, scope, and current root, resolves the remote binding
from host-owned project records, and sends a closed `workspace/pluginFiles` request.
The remote Host advertises this optional capability, accepts it only from paired
owners, and validates canonical containment, protected Host data, the credential
deny-list, and the declared scope before reading; a root must sit under the folder
picker's browse root or match a canonical registered project root, and requested and
canonical file names must both match scope.

The SDK accepts an optional expected workspace identity, and all calls capture their
root before asynchronous admission, so workspace changes, binding replacement, and
plugin unload invalidate late results and remote errors never select a local file of
the same name. Remote workspace metadata adds a display path and a read-only marker
while the opaque identity stays unchanged; this increment covers directories and
classified text/image previews only.

## Consequences

- Older Hosts keep working, a missing capability reports an explicit upgrade error,
  and the service carries neither models nor provider credentials.
- The independently maintained File Manager must consume the SDK for remote projects.
  The integration candidate bundles the consumer as Desktop hotfix `0.9.1-pi.1` with
  its checksums in `UPSTREAM.md`, which does not claim the companion proposal was
  accepted or published.
- Remote editing, filesystem search, watching, and application launching stay
  outside this repair, as does exposing the broader owner file service, which would
  not preserve plugin policy.
