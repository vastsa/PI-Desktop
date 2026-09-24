# ADR 0307: Add selected transcript text to the conversation draft

- Status: Proposed
- Date: 2026-09-23
- Updated: 2026-09-24 after user feedback on the composer presentation
- Amends: ADR 0268, selection-overlay and quote removal only
- Related: issue #921

## Context

ADR 0268 removed a selection toolbar along with annotations and side chats.
That toolbar had several actions, a separate prompt serialization, and extra
session lifecycles. Users still need a direct way to reuse a sentence from a
conversation in their next prompt. Copying, moving to the composer, pasting,
and adding quote markers is unnecessarily slow for this single action.

## Decision

Selecting visible text inside one user message or assistant answer shows one
small action beside the selection: **Add to conversation**. It appends the
selected text as a compact, counted excerpt attachment above the current
session's editable composer text. The badge opens a preview with individual
removal. A collapsed selection has no floating action; the speaking
turn's existing right-click menu also offers the action and falls back to the
whole turn. The action preserves the current draft and file references, focuses
the composer at the end, and never sends automatically.

Excerpts are renderer-memory draft data, scoped to their originating session.
Sending serializes them as quoted context after the user's editable text;
rejected sends and an early Stop restore the attachments with the draft.
Commands that execute locally require removing excerpt attachments first, so
they cannot silently discard them. No persisted schema or host protocol changes.

The floating action belongs to the transcript scroller. It appears only after
selection within one speaking turn's body, stays in the viewport, and closes
when the selection clears, the user scrolls, the window resizes, or the pane
changes. It does not appear for tool output, thinking, the composer, or a
selection crossing turns. A pending insertion is discarded on session change.
The existing Copy action keeps its current behavior.

This is a small renderer-only attachment surface. It does not restore the old
Quote action row, attribution metadata, annotation system, side chats, IPC,
schema, or host changes. The retired decision and E2E IDs in ADR 0268 remain
retired.

## Consequences

The selected-text surface again requires selection ownership, placement, and
dismissal handling. The composer also owns an in-memory excerpt list and a
count badge. The user's typed prompt remains editable and the user decides
whether to send the attached context.
