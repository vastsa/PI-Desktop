# ADR: Pasted local files are live references

- Status: Accepted
- Date: 2026-11-13
- Related: composer-pasted-directory-references, issue #2314, issue #2529

## Context

Copying disk-backed clipboard files into session scratch eagerly allocates and transfers
their full contents, and the transfer bound prevents attaching a large file even when the
task needs only a bounded read.

## Decision

Native clipboard files use the existing sender-bound, one-shot selection token to register
live references in the owning local project: Main creates a UUID record under
`<data_dir>/composer-file-references/` holding only the canonical path, project path, and
originating session id, with no file bytes and no tool access. Drafts, queued input, and
messages carry the additive `localReference` id and byte size shown as name and size, and on
dispatch Main revalidates the record and project, rejects a changed or unavailable target,
and refreshes the size before the agent receives path and size as context to read through
normal tool permissions, requesting referenced images through its Read path. Input history
restores references without reads or snapshots, screenshots and generated payloads keep the
existing scratch materialization, and records without `localReference` are unchanged.
Issue #2529 narrowed the reference flow after it regressed screenshot-tool pastes: image
files within the picker import limits (same image decision, 64 MiB per file, 128 MiB across
the images of one paste) materialize into session scratch and dispatch as regular visual
attachments; non-image files and oversized images keep the live reference, and a paste whose
images exceed the total limit falls back to references for all of them instead of copying a
partial set.

## Consequences

- Transfer byte limits still protect actual transfers, while native references keep the
  20-item selection limit and the attachment-root validator.
- A restored reference observes current file contents and can become unavailable after
  deletion, movement, or project relocation; there is no snapshot and no implicit upload.

## Alternatives

- Keep eager scratch materialization: the transfer bound still refuses large files.
