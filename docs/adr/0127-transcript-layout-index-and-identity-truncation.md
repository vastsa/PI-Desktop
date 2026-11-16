# ADR 0127: Transcript Layout Index and Identity-Based Truncation

- Status: Accepted
- Date: 2026-08-26
- Deciders: PI-Desktop core
- Related: ADR 0120, D119, D122, D139, `03-runtime/04-data-storage.md`,
  `03-runtime/06-host-rpc-protocol.md`, `03-runtime/01-ipc-protocol.md`

## Context

ADR 0120 bounded what a session open sends to the renderer, but explicitly kept
"the sequential scan needed to locate the requested page". That residue is what
users experience as the remaining problem: opening a session is still linear in
the whole conversation, and it degrades as the conversation grows, because the
newest 100 messages can only be found by parsing every line before them.

- The window clamped `messageBefore` against `SessionSummary.message_count`,
  which is `sessions.last_seq` — a deduplicated logical count.
- Regenerate and edit-resend sent `truncateBefore` as
  `sessionHistory[sessionId].messageStart + userIndex`, adding a physical file
  offset to an index into the renderer's deduplicated, display-filtered array.

## Decision

1. **Layout index.** host-core maintains a per-session *transcript layout*: the
   byte offset of every message and compaction line plus the `file_len` those
   offsets were recorded against.
2. **Cheap classification.** Transcript lines are classified by one depth-aware
   scan for the *top-level* `type` key, never by parsing the line into a value.
3. **One coordinate space.** Read-window offsets are physical message-line
   positions, clamped against the layout.
4. **Identity-based truncation.** `agent/prompt` accepts
   `truncateFromMessageId`, and the host resolves that identity against its own
   transcript; an unresolvable id is rejected with `NOT_FOUND` instead of
   truncating at a guessed position.
5. **Durable fork commit.** Recording a forked child (session list, cached
   transcript, checkpoint marks) is unconditional, because it is already durable
   on the host when the call returns.

## Alternatives considered

- **Persist the layout in SQLite:** rejected.
- **Fix the clamp by making `last_seq` authoritative for file positions:**
  rejected.
- **Keep index-based truncation and always rehydrate the full history first:**
  rejected.
- **Refresh the session list after a superseded fork:** rejected as a remedy for
  the lost branch.

## Consequences

- Opening a session, and each older page, costs the requested window rather than
  the conversation length; a large tool result is no longer parsed to be
  skipped.
- The layout is a cache with an explicit validity token, so correctness after a
  crash or rewrite does not depend on it being present or fresh.
- The newest messages of a session with an unindexed file line are visible
  again, and paging backwards reaches the true first message.
- Regenerating from a paged-back transcript replaces the turn the user selected.
- A branch created while the user navigates away is still listed and openable.
