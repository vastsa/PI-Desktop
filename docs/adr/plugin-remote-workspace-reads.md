# ADR: Plugin reads in remote workspaces

## Status

Implemented candidate

## Context

Issue #1711 reports a File Manager that keeps loading in an SSH workspace.
Remote projects have an opaque Desktop identity, not a local filesystem root.

## Decision

Extend the existing `fs.list` and `fs.readPreview` channels with remote reads.
Desktop admits each call against the plugin permission, scope and current root,
resolves the remote binding from host-owned project records, and sends a closed
`workspace/pluginFiles` request.

The SDK accepts an optional expected workspace identity. All calls, including
legacy calls without this argument, capture their root before asynchronous
admission.

## Consequences

Older Hosts remain compatible with existing remote functionality.

The independently maintained File Manager must consume the SDK instead of Node
filesystem calls for remote projects.
