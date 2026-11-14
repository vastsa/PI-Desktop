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
record under `<data_dir>/composer-file-references/` containing only the canonical
path, project path, and originating session id. These small records are retained
with local application data so input history can restore references in another
session of the same project. They contain no file bytes and grant no tool access.

Drafts, queued input and messages carry the additive `localReference` id and byte
size. Composer shows the name and human-readable size. On dispatch, main validates
the record and project, rejects a changed canonical target or unavailable file,
and refreshes size from filesystem metadata. The Agent receives path and size as
context and reads relevant parts through normal tool permissions. Main does not
hydrate referenced images; the Agent can request an image through its normal
Read path. Screenshots and other generated clipboard payloads retain existing
scratch materialization and model image checks. Native picker and drop behavior
is unchanged.

Input history retains the original path, reference id, display metadata and size
captured with the draft. Recording and restoring a reference perform no source
reads or snapshots. Unavailable sources remain restorable and are reported at
dispatch. Restored cards retain their removable inline tokens; dispatch refreshes
the byte size again.

## Consequences

The file transfer byte limits still protect actual transfers, while native
references retain the 20-item selection limit. The attachment-root validator is
unchanged for ordinary attachments; a registered external reference is metadata
only. A restored reference observes current file contents and can become
unavailable after deletion, movement, unmounting, or project relocation. There is
no snapshot or implicit upload. Older records without `localReference` retain
their original behavior. Protocol and database schema versions are unchanged.
