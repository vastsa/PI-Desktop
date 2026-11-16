# ADR 0181: Main-owned picker capabilities

- Status: Accepted
- Date: 2026-09-08
- Related: ADR 0059, ADR 0172, D197, D334, D344

## Context

Composer attachments are chosen in a native Electron file picker and copied into the
session scratch directory after the renderer materializes a home draft. An earlier
flow handed native absolute paths to the renderer and accepted them again through
`composer/importFiles`, which turned the channel into an arbitrary regular-file copy
primitive.

## Decision

`composer/pickFiles` and `composer/pickPhotos` run the native dialog in Electron main,
which stores the selected paths against a random token bound to the invoking
`WebContents`; the token expires after 60 seconds and is consumed before the import
starts. `composer/importFiles` therefore takes the token and a durable `sessionId` and
never renderer-supplied paths, and a token cannot be replayed or used by another
`WebContents`. The picker offers regular files only, and main still realpaths and
stats every source, applies the size limits, and copies only into the session scratch
directory.

## Consequences

- A compromised or stale renderer cannot turn the import channel into an arbitrary
  absolute-path copy primitive.
- Canceling the picker creates no draft session and writes no scratch files.
- The renderer keeps only session-owned scratch references, and no misleading
  directory option is offered.

## Alternatives

- Return native paths and re-validate them at import — rejected: validation does not
  prove user selection.
