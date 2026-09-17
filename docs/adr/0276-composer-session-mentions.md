# ADR 0276: Composer @ mentions other sessions

- Status: Accepted
- Date: 2026-09-16
- Decision: D442
- Amends: ADR 0024, ADR 0070, ADR 0163
- Related: ADR 0237, ADR 0239, ADR 0240, issue #446
## Context

Composer `@` only completed workspace files (ADR 0024). Users who want to point
the current Agent at another durable conversation had to paste a session id or
rely on Session Orchestrator's `SessionTask.list`. There is no `@session`
chip, and a bare title in the draft is not a reference.

Restoring parent-to-parent A2A (ADR 0165) is still rejected. The mention is a
composer address. At send time the desktop may expand that address into a
local Q&A snapshot so the current model can see the other conversation.

## Decision

1. The `@` autocomplete keeps its file grammar. The same menu adds a
   **Sessions** group above **Files**.
2. Session rows come from the renderer's live session list. The current
   session is excluded. An empty query shows the eight most recently updated
   sessions; a query fuzzy-matches title, then id.
3. Accepting a session inserts the same sentinel-backed inline chip as a file.
   The compact label is the session title. The canonical token is
   `@session:<uuid>`.
4. `@session:<uuid>` is not a filesystem path. It is never a structured
   attachment, never opened by `fs/open`, and survives a workspace switch.
   The transcript paints it as a chip; clicking opens that durable session.
5. No host-core, IPC, schema, or `Task*` change. At send time the desktop
   reads the referenced sessions through existing `session.get` pagination.
   The number of included Q&A turns is a result of the shared context budget,
   not a fixed 10-turn default or a 20-turn maximum.
6. A turn concatenates every completed, nonempty parent assistant `content`
   before the next non-delegate user message. Progress text is included;
   thinking, tools, nested delegates, and aborted/error/streaming rows are not.
   Every user message closes the preceding turn, including an empty message.
   Attachment-only questions use an explicit placeholder rather than claiming
   the attachment contents were imported. Strip historical reference wrappers
   per message before joining, never from the aggregate answer.
7. All mentioned sessions share one estimated-token budget, including reference
   headings, titles, and coverage notices. The desktop derives available space
   from the target model window, known context use, the new request and response
   annotations, an output reserve, and a 10% system/tool safety reserve. Output
   reserve uses valid model output metadata (capped at half the window), or 10%
   of the window when unknown. Existing unknown-window fallback is 128,000.
   Estimates use UTF-8 byte length divided by three, rounded up; they are not a
   provider tokenizer or a guarantee about the final runtime request.
8. Settings > AI exposes a renderer-local reference budget preference:
   10%, 25% (default), 50%, or 100% of estimated available space. There is no
   host setting or storage migration. The newest complete turn from every
   nonempty source must fit together; otherwise sending fails visibly and the
   draft survives. Remaining capacity adds older whole turns round-robin,
   preserving a contiguous newest suffix per source. Never truncate a turn or
   skip a too-large recent turn to import older, smaller material instead.
9. Read 400 physical transcript lines per page and follow `messageStart` /
   `hasMoreBefore` until sufficient complete turns are found or history ends.
   Twenty-five pages per source and a 20-second expansion deadline are I/O
   insurance, not silent content limits. Validate cursors, keep cross-page
   question/answer boundaries, and de-duplicate records. A safety stop is
   reported as unread history; zero recovered turns with unread history blocks
   sending instead of claiming the conversation has no completed answers.
   Existing `session.get` does not provide a hard disk-byte bound or a
   transactional snapshot. The first page anchors the historical tail, and the
   resulting text is frozen when submitted; already queued prompts are not
   re-read. The runtime remains the final context-capacity guard.
10. Each reference block states included turns, known omitted turns, and whether
    older history was not read. A localized send-time toast exposes the same
    coverage and estimated size; omission or an I/O safety stop uses a warning.
    Nested `@session` tokens are not expanded. Historical content never grants
    new tool authorization. The transcript still shows the compact chip rather
    than the hidden snapshot. Legacy wrappers remain display-compatible.

## Consequences

- Users can `@` another conversation the same way they `@` a file.
- The current model receives recent Q&A from that session without A2A and
  without importing thinking or tool traces.
- File completion, paste chips, and transcript file chips stay unchanged.

## Alternatives considered

- **A second trigger (`@@` or `#`)**: rejected. The request is to reuse `@`.
- **Pointer only, no snapshot**: rejected for v1 of this expansion. An id
  without content does not give the model the other conversation.
- **Inline the full transcript, including thinking and tools**: rejected.
- **Core A2A messaging**: rejected; ADR 0165 still stands.
- **LLM summarization / RAG / view_chat tool**: deferred. Expansion is a
  deterministic, budget-selected suffix of complete Q&A turns.
- **Fixed turn counts and a per-source character soft cap**: superseded. Physical
  rows do not predict turn boundaries, and an oversized last turn must not bypass
  the total budget.
