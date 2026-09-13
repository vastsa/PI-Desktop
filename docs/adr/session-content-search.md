# ADR session-content-search: Discover sessions by indexed message text

- Status: Accepted
- Date: 2026-09-13
- Issue: https://github.com/vastsa/PI-Desktop/issues/270

## Context

Global search originally filtered the renderer's session titles and project
labels, even though host-core already indexed message text. A remembered error
or sentence could not recover its conversation. A separate historical reader
then duplicated the transcript and required an extra Back to conversation
action. Search results should identify and open the original conversation.

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

Selecting a heading or message preview closes search and opens the owning
conversation through the existing session selection path. The original
transcript, composer, Markdown rendering, live output, and message actions stay
available. Opening a retained conversation follows its existing scroll
restoration; opening the active session does not reload its history. Composer
focus uses `preventScroll`. There is no separate historical reader, extra Back
to conversation action, or forced message-level navigation.

The additive `search.context` RPC and `session/searchContext` IPC remain
compatible for existing callers, but global search no longer uses them. They
still resolve stable IDs against the physical JSONL layout and return bounded
text context; removing the renderer reader does not change the protocol or
storage schema.

Query text survives closing the palette in memory. Query changes and palette
closure invalidate asynchronous result ownership. Existing session navigation
owns conversation loading, live transcript preservation, and workspace changes.

## Consequences and validation

There is no migration or new index to maintain. Short queries and non-ASCII
case mappings still require a literal scan. Search previews stay bounded, and
opening a result uses ordinary session history pagination and retained panes.
Search reads cannot rewrite conversation data or interfere with active turns.

Rust regression tests cover pagination beyond 50 sessions and 100 messages,
literal CJK/symbol queries, complete counts, soft deletion, physical positions,
and target text beyond the display cap. Renderer unit tests cover literal
highlight offsets, stale result/error rejection, cancellation, and pagination.
Historical context regression tests remain as protocol compatibility coverage.
The documented full interaction scenario is
`E2E-SESSION-content-search-and-message-navigation`.
