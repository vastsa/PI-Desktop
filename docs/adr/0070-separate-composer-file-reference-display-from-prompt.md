# ADR 0070: Separate Composer File-Reference Display from Prompt Serialization

- Status: Accepted for implementation
- Date: 2026-08-10
- Deciders: PI-Desktop core
- Related: D124, D197, D209, ADR 0024, ADR 0059

## Context

Workspace autocomplete and clipboard paste both produce canonical file paths
that the agent must receive as plain-text `@` references. Rendering those paths
directly in the controlled composer textarea exposes long workspace paths and,
for pasted files, UUID-backed absolute scratch paths.

## Decision

1. A completed file selection and each materialized clipboard file become a
   renderer-owned, transient composer reference.
2. Each reference stores its canonical path and a compact leaf label.
3. The composer renders references as compact removable chips above the
   textarea.
4. Immediately before the existing submit dispatcher runs, the renderer appends
   references in stable addition order and serializes each with the existing
   `formatFileInsert` quoting rules.
5. Reference-only drafts are sendable.
6. Stopping before assistant text, thinking, or a tool row begins removes the
   just-sent user row and restores the structured snapshot.
7. References are scoped by durable session id and cleared when their workspace
   changes.
8. `ComposerPastedFile.name` is the sanitized original leaf display name.

## Alternatives considered

- **Insert only the basename into the prompt:** rejected because duplicate names
  and external scratch files would no longer resolve reliably.
- **Overlay shortened text on a transparent textarea:** rejected because the
  displayed and native text lengths diverge, breaking caret, selection,
  wrapping, IME, and accessibility behavior.
- **Replace the textarea with `contenteditable`:** rejected for this focused
  change because it would reopen the complete IME, selection, undo, paste, and
  accessibility contract.
- **Parse serialized `@path` tokens back out of an unanswered user message:**
  rejected because user-authored references and renderer-appended references are
  indistinguishable, and the persisted text no longer carries the original
  display label or duplicate-reference identity.

## Consequences

- Long and UUID-backed paths no longer occupy the visible prompt row.
- Canonical references remain exact in persisted messages and model context.
- The renderer owns transient reference state in addition to textarea text.
- Clipboard storage containment, limits, cleanup, and security boundaries are
  unchanged from ADR 0059.
