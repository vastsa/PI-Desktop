# ADR 0070: Separate Composer File-Reference Display from Prompt Serialization

- Status: Accepted for implementation
- Date: 2026-08-10
- Related: D124, D197, D209, ADR 0024, ADR 0059

## Context

Workspace autocomplete and clipboard paste both produce canonical file paths the
agent must receive as plain-text `@` references, but rendering them inline
exposes long workspace paths and UUID-backed scratch paths that wrap and crowd
out the task. A native textarea cannot display one substring differently, and a
shortened value cannot be expanded back by basename because duplicate leaf names
and scratch paths are both valid.

## Decision

1. A completed file selection and each materialized clipboard file become a
   renderer-owned transient reference while the textarea keeps only ordinary
   text; directory autocomplete stays literal.
2. Each reference stores its canonical path and a compact leaf label, keeping the
   full relative index path for workspace files and the UUID-backed scratch path
   for pastes while displaying the sanitized leaf name from `composer/pasteFiles`.
3. References render as compact removable chips above the textarea that show only
   the leaf label, with the canonical path in the tooltip and accessible name;
   duplicate labels stay separate references.
4. Immediately before the submit dispatcher runs, references are appended in
   stable addition order and serialized with the existing `formatFileInsert`
   quoting rules, so the prompt stays plain text with the exact
   `@relative/path` or `@absolute/path`.
5. Reference-only drafts are sendable, references follow visible text so slash
   templates and `/agent-mode`, `/plan-mode`, and `/goal-mode` stay recognizable,
   and rejected or failed dispatch keeps the draft.
6. A session- and turn-scoped snapshot of pre-serialization text and references
   is restored when a stop happens before assistant text, thinking, or a tool row
   begins; once a reply starts, abort keeps the partial transcript and restores
   no draft.
7. References are scoped by durable session id and cleared when their workspace
   changes, and `ComposerPastedFile.name` is the sanitized leaf name while `path`
   carries the UUID storage name. No IPC, host RPC, or storage field is added.

## Consequences

- Long and UUID-backed paths no longer occupy the visible prompt row.
- Canonical references stay exact in persisted messages and model context.
- The renderer owns transient reference state beside textarea text, with
  clipboard containment and limits unchanged from ADR 0059.

## Alternatives

- Insert only the basename into the prompt: rejected, duplicate names and scratch
  files would not resolve reliably.
- Overlay shortened text on a transparent textarea: rejected, displayed and
  native lengths diverge and break caret, selection, IME, and accessibility.
