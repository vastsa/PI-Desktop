# ADR session-content-search: Discover sessions by indexed message text

- Status: Accepted
- Date: 2026-09-13
- Issue: https://github.com/vastsa/PI-Desktop/issues/270

## Context

Global search filters the renderer's session titles and project labels, even
though host-core already indexes message text. A remembered error or sentence
cannot recover its conversation. Opening a title result also loses the location
of an older matching message.

## Decision

Add `search.sessions` and `search.context` host RPCs with allowlisted desktop
`session/search` and `session/searchContext` IPC channels. Keep the legacy
`search.query`, `session.get`, protocol version, and storage schema compatible.
Rust remains the sole SQLite owner; Electron forwards search requests and the
renderer owns presentation and transient query state.

`search.sessions` searches all non-deleted sessions, combining title/project
metadata with indexed user/assistant text. Trigram FTS supplies candidates for
queries of at least three Unicode characters. A host-owned Unicode literal
predicate verifies those candidates and handles shorter queries. Queries with
non-ASCII case mappings use that predicate directly to avoid tokenizer
Unicode-version gaps. Retrieval and highlighting both use Unicode lowercase
and map expanding case conversions back to original text. Quotes, `%`, `_`,
and backslashes never become operators. Queries are trimmed and bounded to
500 characters. Each page contains 30 sessions ordered by updated time and ID,
full matching-message counts, and at most two recent message excerpts. Offsets
continue the current query; reopening refreshes results against current data.

Body previews use the sentence or line containing the first match. Chinese and
English sentence punctuation and line breaks bound the preview; periods inside
paths or identifiers do not end a sentence. Sentences longer than 180 characters
use a bounded match-centered excerpt that preserves the complete query. The
renderer wraps the full returned preview without a line clamp and uses a
visible background highlight, so preceding newlines or a narrow window cannot
hide the matching text.

Archive preferences stay renderer-owned: empty-query recents hide archived
sessions, while explicit searches retain the existing archived-session discovery
behavior. Tools, thinking, attachments, and discarded revisions do not expand
the searchable body scope.

Selecting a message opens its owning session and a bounded historical reader
inside that conversation. `search.context` resolves its stable ID against the
physical JSONL layout and returns at most 21 nearby message text projections.
Adjacent context pages contain at most 20 messages. The reader provides previous
and next matching-message navigation, so two previews never cap discovery within
one conversation. Deleted or rewritten-away targets return `NOT_FOUND`.

JSONL remains authoritative for displayed context. Text is capped at 64 Ki
characters per message, with the target excerpt centered around the query so a
match beyond the usual display cap remains visible. Context uses literal text
instead of executing/rendering Markdown; tool rows identify their tool without
loading their results into this reader.

Historical search windows never replace, merge into, or persist through the
live transcript cache. Existing retained panes keep their messages and scroll
positions while hidden. The Back to conversation action, composer focus, or
selection of another conversation exits the historical reader. Query text survives closing
the palette in memory. Query changes, palette closure, and context navigation
invalidate asynchronous result ownership.

## Consequences and validation

There is no migration or new index to maintain. Short queries and non-ASCII
case mappings still require a literal scan. Resolving an old message may scan IDs in the existing physical
layout, but only the nearby text window crosses IPC or mounts in the renderer.
Search reads cannot rewrite conversation data or interfere with active turns.

Rust regression tests cover pagination beyond 50 sessions and 100 messages,
literal CJK/symbol queries, complete counts, soft deletion, physical positions,
and target text beyond the display cap. Renderer unit tests cover literal
highlight offsets, stale result/error rejection, cancellation, and pagination.
The documented full interaction scenario is
`E2E-SESSION-content-search-and-message-navigation`.
