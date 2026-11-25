# ADR: Pasted local files are live references

- Status: Accepted
- Date: 2026-11-13
- Related: composer-pasted-directory-references, issue #2314, issue #2529

## Context

Copying disk-backed clipboard files into session scratch eagerly allocates and transfers
their full contents, and the transfer bound prevents attaching a large file even when the
task needs only a bounded read.

Image files are different: screenshot tools such as PixPin place a temporary image file
rather than a bitmap on the clipboard. Referencing that file sent the model only a path, so
vision models could not see the image, and the temporary file may be gone before an agent
reads it or a transcript is replayed (issue #2529).

## Decision

Native clipboard image files (raster images, not SVG) that fit the existing import bounds
(64 MiB per file, 128 MiB and 20 files per batch) are copied into session scratch exactly
like native-picker imports and are sent as image attachments; images beyond those bounds
fall back to the reference flow below instead of failing the paste. Image imports do not
require a local project. Results keep the paste order.

Other native clipboard files use the existing sender-bound, one-shot selection token to register
live references in the owning local project: Main creates a UUID record under
`<data_dir>/composer-file-references/` holding only the canonical path, project path, and
originating session id, with no file bytes and no tool access. Drafts, queued input, and
messages carry the additive `localReference` id and byte size shown as name and size, and on
dispatch Main revalidates the record and project, rejects a changed or unavailable target,
and refreshes the size before the agent receives path and size as context to read through
normal tool permissions, requesting any referenced oversized image through its Read path. Input history
restores references without reads or snapshots, screenshots and generated payloads keep the
existing scratch materialization, and records without `localReference` are unchanged.

## Consequences

- Transfer byte limits still protect actual transfers, while native references keep the
  20-item selection limit and the attachment-root validator.
- A restored reference observes current file contents and can become unavailable after
  deletion, movement, or project relocation; there is no snapshot and no implicit upload.

- Pasted image files behave like picked or dropped images: their bytes are snapshotted at
  paste time and survive deletion of the source file.

## Alternatives

- Keep eager scratch materialization: the transfer bound still refuses large files.
- Reference image files too and let the agent read them: vision models receive only a path,
  and temporary screenshot files can disappear before they are read (issue #2529).
