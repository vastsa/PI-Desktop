# ADR floating-annotation-index: Floating Annotation Index and Source Locations

- Status: Accepted
- Date: 2026-09-12
- Amends: ADR response-annotations / D-LOCAL-response-annotations (annotation presentation and duplicate identity)
- Preserves: D209, D301, D261, D-LOCAL-selection-overlay; protocol v11 and schema v15

## Context

The comment editor solved missing comment entry, but a composer-only attachment
list did not show where selections were made. The user explicitly requested a
Codex-like collapsible floating panel with annotation numbers and source locations.
The reference bundle uses out-of-flow numbered source buttons; inserting marker
text into Markdown previously broke words, selections, and formulas.

## Decision

1. Replace the composer attachment popover with one floating annotation index in
   the visible, writable transcript pane, above the composer. It starts expanded,
   collapses to its count header, and stays open during reading. It lists numbered
   excerpts, comments, locate, edit, remove, and clear-all controls. Collapsing does
   not remove annotations or source badges. The existing modal comment editor stays.
2. Source badges use the same one-based array order as the list and prompt payload.
   Every saved, resolvable selection stays highlighted by a non-interactive
   overlay while visible, without a click and even when the index is collapsed.
   Clicking a list item or badge navigates within the pane; it does not switch
   off other highlights. Removal/clear/send removes the corresponding highlights;
   an unresolved row fallback never highlights the whole answer. The transcript releases
   follow-to-bottom first; an older source expands the mounted history window by
   at most D261's 40 rows per frame or loads older pages, stopping on exhaustion,
   error, or no progress.
3. A renderer-only optional anchor stores start/end offsets and exact text from
   answer text nodes, captured before selection collapse. Code chrome, KaTeX's
   duplicate MathML, and citation markers are excluded; formula endpoints expand
   to the whole formula. Resolve at the original offset first; a shifted selection
   relocates only when its exact text is unique. An unresolved selection falls back
   to its source row, with a row-location tooltip rather than a false exact match.
4. Deduplication uses source row, excerpt, and selected offsets. Repeating the same
   selection edits it; identical words at distinct locations or in different turns
   remain separate annotations with separate numbers. When either entry point
   lacks offsets, the location is unknown, not a distinct occurrence: the same
   row/excerpt reopens the existing annotation. Editing preserves anchors.
5. Source badges/highlights are portaled outside the answer DOM and cannot change
   answer layout, serialized Markdown, clipboard content, or prompt text. They
   follow scroll, resize, and content mutations, clipped above the composer.
   Coincident badges stack; badges that cannot fit the visible band are omitted
   from that band only, while every annotation remains reachable in the index.
6. Hidden retained panes and read-only side-chat projections render no annotation
   overlays. State and numbering remain session-owned. Send/clear/remove use the
   existing attachment lifecycle; nothing is persisted or retained after send.
   Anchor metadata is explicitly omitted from the existing prompt payload.

## Scope

No new dependency, IPC, host command, schema, storage, or permission. The user has
not requested persistent review history or movable/native windows; the panel is
an in-app floating surface. Model-authored citation rendering is unchanged and is
separate from these user-owned source badges.

## Validation

Executable tests cover duplicate occurrences, ambiguous/stale anchors, split text
nodes, comment/anchor payload separation, collision placement, and floating-panel
toggle/locate/edit/remove handlers. Source contracts cover pane visibility and
history navigation. E2E-CHAT-annotation-source-index documents real-app checks; no E2E or GUI run is claimed.
