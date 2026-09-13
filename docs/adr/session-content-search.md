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

Selecting a message preview closes search, selects its original conversation,
and scrolls the existing transcript to the clicked message's matching rendered
text. A heading with body matches selects its first preview; metadata-only
headings retain normal sidebar navigation. Mouse and keyboard carry the same
stable message ID. Each assistant fragment exposes its own anchor even when
several fragments share a single assistant-turn row. Literal text ranges are
highlighted without rewriting the React-owned Markdown tree. Parser-owned source
offsets map hidden Markdown destinations or syntax to the corresponding visible
link, image, code block, or file chip. A source-only match highlights that element
instead of silently scrolling to the message's beginning. Navigation releases
bottom following and briefly anchors while asynchronous layout settles; a real
reading gesture ends that correction. Composer focus uses `preventScroll`.

The additive `session.get({ messageAround, messageLimit, contentLimit })` form
resolves a stable ID against physical JSONL positions and returns the original
`UiMessage` projection centered on that ID. It requires a positive limit and is
mutually exclusive with `messageBefore`. A missing target returns no session,
never an unrelated tail. The renderer requests 60 lines. Neighbors and tool
payloads retain their display caps; only the explicitly selected user/assistant
message's text is complete, including a match beyond the usual 64 KiB cap.
Bounded responses add exclusive `messageEnd` and `hasMoreAfter`, so forward
paging uses physical positions rather than deduplicated array lengths. For a
nested assistant answer, optional `navigationParent` carries the latest owning
Task projection, even outside the selected page. This capped display context
does not change the page's messages or physical cursors. The main transcript
reveals the Task activity group and the existing subagent dock locates the
selected answer. A missing parent reports failure rather than an invisible hit.

The renderer store owns one reading view per retained session for both ordinary
history paging and search navigation. This ownership is defined in
[ADR transcript-reading-ownership](/adr/transcript-reading-ownership). MainChat and subagent details consume the
same projection; no global target handoff, effect-driven navigation controller,
or second historical reader is needed. Ordinary history merges authoritative
live output. An explicit search keeps its selected snapshot until returning to
latest or starting a new turn. Neither mode writes to live/model caches.

Upward paging and Load later messages extend the view contiguously. The pending
view's identity owns each read; newer navigation, pane eviction, edits, or
returning to latest invalidate stale completions. Starting a turn cancels both
focused views and in-flight target reads. Idle canonical changes invalidate a
view when message IDs disappear or the same IDs change content or revision.
Message actions prepare canonical input if history is incomplete or text was
display-limited, even when the target is already visible. This full read runs
only for explicit actions, rechecks ownership before publishing, and never uses
reading-view content as model input. Search itself stays bounded.

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
opening a result uses a bounded original transcript window in its retained pane.
Search reads cannot rewrite conversation data or interfere with active turns.

Rust regression tests cover pagination beyond 50 sessions and 100 messages,
literal CJK/symbol queries, complete counts, soft deletion, physical positions,
and target text beyond the display cap. Renderer unit tests cover literal
highlight offsets, stale result/error rejection, cancellation, and pagination.
Regressions also cover stable-ID navigation past the tail/display cap, physical
cursors, stale jump/page rejection, ordinary paging during streaming, nested
answers whose parent is outside the page, source-only Markdown/file-chip hits,
and explicit action preparation from incomplete or capped history. Browser-effect
unit tests cover layout correction, gesture interruption, and replay cleanup;
server rendering tests verify the actual Markdown and subagent markup.
Historical context regression tests remain as protocol compatibility coverage.
The documented full interaction scenario is
`E2E-SESSION-content-search-and-message-navigation`.
