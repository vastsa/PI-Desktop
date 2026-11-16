# ADR transcript-reading-ownership: Share renderer history and search views

- Status: Accepted
- Date: 2026-09-13
- Amends: [ADR session-content-search](/adr/session-content-search)

## Context

Search navigation added a pane-local controller beside ordinary history paging,
a global target handoff, and live and model caches, so independent paths needed
separate cancellation and rewrite handling, nested assistant answers had no
top-level transcript row, and Markdown could hide the source characters that
matched a query.

## Decision

The renderer store owns one transient `TranscriptView` per retained session:
ordinary paging and search share the same read actions and physical cursors,
MainChat and the subagent dock share the same projection, the pending view's
identity owns an asynchronous read, and replacement, eviction, return to latest,
canonical edits, and new turns invalidate stale completions. Ordinary history
always uses the current canonical value for overlapping rows while an explicit
search keeps its selected historical snapshot until the user leaves it or starts
a turn, and reading views never populate runtime or model caches. The additive
`SessionDetail.navigationParent` field carries a nested target's latest owning
Task as capped display context without widening the physical page, and
parser-owned source offsets map hidden Markdown syntax and destinations to
visible elements.

## Consequences

- The global target transfer, pane-local navigation controller, and separate
  ordinary-history load lock are gone, while cache ownership, transcript
  storage, IPC allowlisting, and the protocol version are unchanged.
- Navigation never loads a whole transcript into the renderer, but stable-ID and
  parent lookup still scan canonical physical identities.
- The optional parent projection stays backward compatible for existing
  session readers.

## Alternatives

No alternative kept the single read path: a pane-local controller duplicates
cancellation and rewrite handling, which is the problem this record removes.
