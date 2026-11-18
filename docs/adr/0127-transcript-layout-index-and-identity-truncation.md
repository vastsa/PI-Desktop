# ADR 0127: Transcript Layout Index and Identity-Based Truncation

- Status: Accepted
- Date: 2026-08-26
- Related: ADR 0120, D119, D122, D139, `03-runtime/04-data-storage.md`, `03-runtime/06-host-rpc-protocol.md`, `03-runtime/01-ipc-protocol.md`

## Context

ADR 0120 bounded what a session open sends to the renderer but kept the
sequential scan used to locate the requested page, so opening a session stayed
linear in the conversation and every line was deserialized merely to be
classified. Two coordinate-space bugs shared that path: the window clamped
`messageBefore` against the deduplicated `SessionSummary.message_count` instead
of physical file lines, hiding the newest messages, and regenerate sent
`truncateBefore` as a file offset plus a display index, truncating at the wrong
point. A host-side fork could also vanish from the UI when its navigation intent
was superseded after the child had been created.

## Decision

1. **Layout index.** host-core keeps a per-session transcript layout with the
   byte offset of every message and compaction line and the `file_len` it was
   recorded against, so a bounded window seeks directly to its first line. The
   layout is derived data cached in memory: growth scans the tail, shrink or
   replacement rescans, every rewrite and delete path drops the entry, and a torn
   trailing line is excluded until the writer completes it.
2. **Cheap classification.** Lines are classified by one depth-aware scan for the
   top-level `type` key instead of being parsed into a value, because tool
   results and checkpoint details can nest an object with its own `type`. New
   lines write `type` first, older ordering is read by the same scan, and no
   migration is required.
3. **One coordinate space.** Window offsets are physical message-line positions
   clamped against the layout, `last_seq` is never used for them, and the
   compaction chain is still returned whole.
4. **Identity-based truncation.** `agent/prompt` accepts
   `truncateFromMessageId`, resolved against the host transcript, with an
   unresolvable id rejected as `NOT_FOUND` instead of truncating at a guess;
   `truncateBefore` stays accepted for older callers.
5. **Durable fork commit.** Recording the forked child is unconditional because it
   is already durable on the host, and only the visible switch stays gated on the
   navigation intent still being current.

## Consequences

- Opening a session and each older page costs the window rather than the history,
  and a large tool result is no longer parsed to be skipped; the first open still
  pays one index scan.
- The layout is a cache with an explicit validity token, so correctness after a
  crash or rewrite never depends on it.
- Newest messages of an unindexed file line are visible again, paging reaches the
  true first message, and a branch created while navigating away stays listed.

## Alternatives

- Persist the layout in SQLite: rejected, it adds a schema migration and a second
  source of truth for cheap derived data.
- Make `last_seq` authoritative for file positions: rejected, it would require
  rewriting transcripts to repair a derived index.
