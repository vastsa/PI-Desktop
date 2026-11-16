# ADR: Pasted local files are live references

- Status: Accepted
- Date: 2026-11-13
- Related: composer-pasted-directory-references, issue #2314

## Context

Copying disk-backed clipboard files into session scratch eagerly allocates and
transfers their full contents. The 64 MiB transfer bound prevents attaching a
large file even when the task needs only a bounded read.

## Decision

Native clipboard files use the existing sender-bound, one-shot selection token
to register live references in the owning local project. Main creates a UUID
record under `<data_dir>/composer-file-references/` containing only the
canonical path, project path, and originating session id.

Drafts, queued input and messages carry the additive `localReference` id and
byte size. Composer shows the name and human-readable size.

## Consequences

The file transfer byte limits still protect actual transfers, while native
references retain the 20-item selection limit.
