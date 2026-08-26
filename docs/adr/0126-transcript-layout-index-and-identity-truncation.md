# ADR 0126: Transcript Layout Index and Identity-Based Truncation

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
newest 100 messages can only be found by parsing every line before them. The
scan also deserialized a `type` discriminator per line, so a single large tool
result was walked in full merely to be classified and skipped.

Two further defects were found in the same path, both coordinate-space
confusions rather than performance issues:

- The window clamped `messageBefore` against `SessionSummary.message_count`,
  which is `sessions.last_seq` — a deduplicated logical count. Transcript
  positions are physical file lines. A message whose durable file append
  succeeded while its index commit did not (a documented crash window) leaves
  the counter permanently below the line count, and the tail window then cut off
  the newest messages: they existed on disk and never reached the renderer.
- Regenerate and edit-resend sent `truncateBefore` as
  `sessionHistory[sessionId].messageStart + userIndex`, adding a physical file
  offset to an index into the renderer's deduplicated, display-filtered array.
  The sum only addresses the intended message when the renderer holds the entire
  history, so regenerating from a paged-back transcript could truncate at the
  wrong point and archive the wrong tail as a revision.

Separately, a session fork committed on the host could vanish from the UI: both
fork actions returned early when their navigation intent (D139) was superseded,
after `api.forkSession` had already created the child. The branch stayed on disk
and was absent from the sidebar until a manual refresh.

## Decision

1. **Layout index.** host-core maintains a per-session *transcript layout*: the
   byte offset of every message and compaction line plus the `file_len` those
   offsets were recorded against. A bounded window seeks directly to its first
   selected line, so serving it costs the window and not the history in front of
   it. The layout is derived data cached in memory: `file_len` detects growth
   (scan the tail only), shrink or replacement (rescan), and every rewrite and
   delete path drops the entry because a rewrite can reproduce the same length.
   A torn trailing line is excluded from both offsets and `file_len` so a later
   refresh adopts it once the writer completes it.
2. **Cheap classification.** Transcript lines are classified by one depth-aware
   scan for the *top-level* `type` key, never by parsing the line into a value.
   Depth matters: tool results and checkpoint details are open-ended JSON and can
   nest an object whose own `type` names a line kind, which a positional or
   first-match check misreads. `type` is written first on every new line so the
   scan normally stops at the first key, while lines written under the previous
   ordering carry it after their payload and are read by the same scan, so no
   migration is required.
3. **One coordinate space.** Read-window offsets are physical message-line
   positions, clamped against the layout. `last_seq` is never used for this
   purpose. The compaction chain is still returned whole with any window,
   because the newest checkpoint drives model context.
4. **Identity-based truncation.** `agent/prompt` accepts
   `truncateFromMessageId`, and the host resolves that identity against its own
   transcript; an unresolvable id is rejected with `NOT_FOUND` instead of
   truncating at a guessed position. `truncateBefore` remains accepted for older
   callers with its correctness condition stated.
5. **Durable fork commit.** Recording a forked child (session list, cached
   transcript, checkpoint marks) is unconditional, because it is already durable
   on the host when the call returns. Only the visible switch — active session,
   transcript, work panel, history entry — remains gated on the navigation
   intent still being current.

## Alternatives considered

- **Persist the layout in SQLite:** rejected. It is cheap to rebuild, and a
  durable copy adds a schema migration plus a second source of truth that can
  disagree with the file after a crash.
- **Fix the clamp by making `last_seq` authoritative for file positions:**
  rejected. It is a deduplicated counter by design; making the file conform to
  it would mean rewriting transcripts to repair a derived index.
- **Keep index-based truncation and always rehydrate the full history first:**
  rejected. It reintroduces exactly the full-history read this change removes,
  on the most latency-sensitive action in the product.
- **Refresh the session list after a superseded fork:** rejected as a remedy for
  the lost branch. It relies on an extra round trip to repair state the renderer
  already had in hand.

## Consequences

- Opening a session, and each older page, costs the requested window rather than
  the conversation length; a large tool result is no longer parsed to be skipped.
  Measured on synthetic transcripts of 3,000 messages / 32 MB and 12,000 /
  129 MB, a warm tail window stays around 0.7-0.8 ms while the previous
  sequential read grew from 6 ms to 25 ms, so the cost stops tracking history
  length. The first open of a session still pays one index scan.
- The layout is a cache with an explicit validity token, so correctness after a
  crash or rewrite does not depend on it being present or fresh.
- The newest messages of a session with an unindexed file line are visible again,
  and paging backwards reaches the true first message.
- Regenerating from a paged-back transcript replaces the turn the user selected.
- A branch created while the user navigates away is still listed and openable.
