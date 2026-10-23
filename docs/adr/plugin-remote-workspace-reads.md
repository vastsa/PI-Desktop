# ADR: Plugin reads in remote workspaces

## Status

Implemented candidate

## Context

Issue #1711 reports a File Manager that keeps loading in an SSH workspace.
Remote projects have an opaque Desktop identity, not a local filesystem root.
The upstream plugin currently passes that identity to its own Node filesystem.
Existing owner-only `workspace/files` reads do not enforce a plugin's declared
file scope, so directly forwarding plugin requests to that service would widen
their access.

## Decision

Extend the existing `fs.list` and `fs.readPreview` channels with remote reads.
Desktop admits each call against the plugin permission, scope and current root,
resolves the remote binding from host-owned project records, and sends a closed
`workspace/pluginFiles` request. The remote Host advertises this optional
capability and accepts it only from paired owners. It validates canonical
containment, protected Host data, the credential deny-list and the declared
scope before reading. Requested and canonical file names must both match scope.

The SDK accepts an optional expected workspace identity. All calls, including
legacy calls without this argument, capture their root before asynchronous
admission. Workspace changes, binding replacement and plugin unload invalidate
late results. Remote errors never select a local file of the same name.

Remote workspace metadata adds a display path and a read-only marker; the
opaque primary identity stays unchanged. This increment supports directories
and classified text/image previews only. Other filesystem channels reject
opaque remote roots explicitly. Existing local operations retain their policy.

## Consequences

Older Hosts remain compatible with existing remote functionality. A missing
plugin-files capability reports an explicit upgrade error for these new reads.
This service carries neither models nor provider credentials.

The independently maintained File Manager must consume the SDK instead of
Node filesystem calls for remote projects. Its release and the bundled plugin
update are separate delivery steps; this Host change alone does not close
#1711. Pinned bundled sources and their upstream checksums remain unchanged.

The alternative of exposing the broader owner file service was rejected
because it does not preserve plugin policy. Remote editing, filesystem search,
watching and local application launching are outside this bounded repair.
