# ADR session-content-search: Discover sessions by indexed message text

- Status: Accepted
- Date: 2026-09-13
- Related: issue #270

## Context

Global search filtered the renderer's session titles and project labels even though
host-core already indexed message text, so a remembered error or sentence could not
recover its conversation, and a separate historical reader duplicated the transcript
behind an extra Back to conversation action. Search results should identify and open
the original conversation.

## Decision

Add the `search.sessions` and `search.context` host RPCs behind allowlisted
`session/search` and `session/searchContext` IPC channels, keeping `search.query`,
`session.get`, the protocol version, and the storage schema compatible. Rust stays
the sole SQLite owner, Electron forwards requests, and the renderer owns presentation
and transient query state.

`search.sessions` searches all non-deleted sessions, combining title and project
metadata with indexed user and assistant text. Trigram FTS supplies candidates for
queries of at least three Unicode characters, and a host-owned Unicode literal
predicate verifies them and handles shorter or non-ASCII-cased queries, so quotes,
`%`, `_`, and backslashes never become operators. The whole query is a literal
substring, not split into words or read as FTS syntax. Results are paged by updated
time and id with full matching-message counts and at most two recent excerpts per
session, and offset paging continues the current query.

Previews use the sentence or line containing the first match, with Chinese and
English punctuation and line breaks as bounds and a bounded match-centered excerpt
for very long sentences. Archive preferences stay renderer-owned: empty-query recents
hide archived sessions while an explicit search keeps the existing archived
discovery behavior, and tools, thinking, attachments, and discarded revisions stay
outside the searchable body.

Selecting a message preview closes search, selects the original conversation, and
scrolls the existing transcript to that message's matching rendered text, using a
stable message id for mouse and keyboard alike. Each assistant fragment exposes its
own anchor even when fragments share one assistant-turn row, literal ranges are
highlighted without rewriting the React-owned Markdown tree, and parser-owned source
offsets map hidden Markdown destinations to the visible link, image, code block, or
file chip so a source-only match highlights that element.

The additive `session.get({ messageAround, messageLimit, contentLimit })` form
resolves a stable id against physical JSONL positions and returns the original
`UiMessage` projection centered on it. It requires a positive limit, is mutually
exclusive with `messageBefore`, and returns no session for a missing target instead
of an unrelated tail. Only the selected message's text is complete, including a
match beyond the usual display cap, and bounded responses add exclusive `messageEnd`
and `hasMoreAfter` so forward paging uses physical positions. For a nested answer,
optional `navigationParent` carries the owning Task projection and the subagent dock
locates it, while a missing parent reports failure instead of an invisible hit.

The renderer store owns one reading view per retained session for both ordinary
paging and search navigation, as defined in
[ADR transcript-reading-ownership](/adr/transcript-reading-ownership), so no second
historical reader is needed. Ordinary history merges authoritative live output, an
explicit search keeps its snapshot until the user returns to latest or starts a
turn, and neither mode writes live or model caches. Reads are owned by the pending
view's identity, so newer navigation, pane eviction, edits, or a return to latest
invalidate stale completions.

## Consequences

- There is no migration and no new index to maintain, though short and
  non-ASCII-cased queries still need a literal scan.
- Search previews stay bounded, and a search read cannot rewrite conversation data
  or disturb an active turn.
- `search.context` and `session/searchContext` stay compatible for existing callers
  even though global search no longer uses them. The documented scenario is
  `E2E-SESSION-content-search-and-message-navigation`.
