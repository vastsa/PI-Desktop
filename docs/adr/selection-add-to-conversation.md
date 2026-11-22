# ADR: Add selected transcript text to the conversation draft

- Status: Proposed
- Date: 2026-09-23
- Updated: 2026-09-24 after user feedback on the composer presentation
- Updated: 2026-11-22 after review: the action lives only in the right-click menu
- Related: ADR 0268, issue #921

## Context

Users need a direct way to reuse a sentence from a conversation in their next
prompt. Copying, moving to the composer, pasting, and adding quote markers is
unnecessarily slow for this single action.

ADR 0268 retired the selected-text toolbar, together with annotations and side
chats. An earlier draft of this ADR brought back a floating control beside the
selection. Review rejected it: it opened on every selection, and the
right-click that would reveal the menu dismissed it, which made the menu
action hard to discover. This ADR keeps ADR 0268's decision in place.

## Decision

The speaking turn's existing right-click menu offers **Add to conversation**.
When the menu opens over a live selection inside that turn's body, the action
attaches only the selected text; a collapsed caret or a selection outside the
row falls back to the whole turn. No control appears when text is selected,
and no selection toolbar returns.

The action appends the text as a compact, counted excerpt attachment above the
current session's editable composer text. The badge opens a preview with
individual removal. The action preserves the current draft and file
references, focuses the composer at the end, and never sends automatically.
A pending insertion is discarded on session change.

Excerpts are renderer-memory draft data, scoped to their originating session.
Sending serializes them as quoted context after the user's editable text;
rejected sends and an early Stop restore the attachments with the draft.
Commands that execute locally require removing excerpt attachments first, so
they cannot silently discard them. No persisted schema or host protocol changes.

This is a renderer-only menu item and attachment surface. It does not restore
the selection toolbar, the old Quote action row, attribution metadata, the
annotation system, side chats, IPC, schema, or host changes. The decision and
E2E IDs retired by ADR 0268 stay retired.

## Consequences

The menu needs no new selection ownership, placement, or dismissal handling;
it reuses the live-selection rule that Copy already applies. The composer owns
an in-memory excerpt list and a count badge. The user's typed prompt remains
editable and the user decides whether to send the attached context.
