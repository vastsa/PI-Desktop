# ADR session-content-search: Discover sessions by indexed message text

- Status: Accepted
- Date: 2026-09-13
- Issue: https://github.com/vastsa/PI-Desktop/issues/270

## Context

Global search originally filtered the renderer's session titles and project
labels, even though host-core already indexed message text. A remembered error
or sentence could not recover its conversation.

## Decision

Add `search.sessions` and `search.context` host RPCs with allowlisted desktop
`session/search` and `session/searchContext` IPC channels. Keep the legacy
`search.query`, `session.get`, protocol version, and storage schema compatible.

`search.sessions` searches all non-deleted sessions, combining title/project
metadata with indexed user/assistant text. Trigram FTS supplies candidates for
queries of at least three Unicode characters.

## Consequences and validation

There is no migration or new index to maintain.

Rust regression tests cover pagination beyond 50 sessions and 100 messages,
literal CJK/symbol queries, complete counts, soft deletion, physical positions,
and target text beyond the display cap.
