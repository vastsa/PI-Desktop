# ADR transcript-reading-ownership: Share renderer history and search views

- Status: Accepted
- Date: 2026-09-13
- Amends: [ADR session-content-search](/adr/session-content-search)

## Context

Search navigation added a pane-local controller alongside ordinary history
paging, a global target handoff, and live/model caches. These independent paths
needed separate cancellation and rewrite handling.

## Decision

The renderer store owns one transient `TranscriptView` per retained session.
Ordinary paging and search use the same read actions and physical cursors;
MainChat and the subagent dock use the same projection.

Reading views never populate runtime/model caches. A message action hydrates
canonical input when history is partial or display-limited, then rechecks the
session, run, navigation, and message-snapshot ownership before publishing it.

## Consequences

This removes the global target transfer, pane-local navigation controller, and
separate ordinary-history load lock.

Navigation does not load an entire transcript into the renderer.
