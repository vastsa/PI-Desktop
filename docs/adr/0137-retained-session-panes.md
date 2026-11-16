# ADR 0137: Retained Session Panes

- Status: Accepted
- Date: 2026-08-30
- Deciders: PI-Desktop core
- Related: D162, D261, D317, D324, ADR 0120, ADR 0127, ADR 0130, D142,
  `04-ux/08-component-spec.md` §3.5 / §7, `04-ux/09-interaction-patterns.md` §5,
  E2E-011, E2E-071d, E2E-071g, E2E-177, E2E-183
- Amends: D162 (the dimmed keep-alive frame), ADR 0130 clause 4 and clause 5
  (per-session window reset and first-commit hydration), D162's
  "activation resets manual-scroll state" rule for revisits

## Context

D162 already avoided the worst session-switch artifact: it kept the last settled
transcript mounted instead of tearing it down to a skeleton. The switch still
flashed, because keeping *a* transcript mounted is not the same as keeping *the
destination's* transcript mounted.

- The kept frame was **dimmed** (`opacity: .82`, `pointer-events: none`) under a
  thin progress track.
- **Scroll position was not the pane's**.
- The **two-stage progressive hydration** of ADR 0130 clause 5 ran on every
  switch: mount the trailing 15 rows for one frame behind a `100vh` spacer, then
  expand in a rAF and re-anchor.

## Decision

1. `ChatSurface` mounts one **`SessionPane` per retained session id**, keyed by
   session id.
2. Retention is a **bounded LRU of 3 panes**: the visible one plus the two most
   recently visited.
3. An inactive pane stays mounted, hidden with `visibility: hidden` +
   `content-visibility: hidden`, `aria-hidden`, and non-interactive.
4. `messages` remains the **live projection of the store-active session**.
5. A **warm switch** — the destination already has a retained pane — reveals
   that pane immediately from its retained content.
6. A **cold switch** — no retained pane — keeps the currently visible pane
   showing its own session until the destination commits.
7. **DOM retention is per pane; reading retention is per session.** A pane still
   pinned re-anchors to the bottom.
8. The **first commit is per pane and local**.
9. The **composer is mounted once** for the whole chat surface rather than once
   per branch — it already carries a per-session draft cache.

No IPC, storage, host protocol, or pagination change. Transcript reads, the
latest-wins navigation generation, and the five-snapshot transcript cache of
D162 are untouched; panes are a renderer-side presentation bound, not a second
cache.

## Consequences

- Retained renderer memory grows by at most two extra mounted transcripts, each
  itself bounded by ADR 0130's window.
- A revisit within the budget costs no Markdown parse, no Shiki tokenization,
  and no scroll correction — the frame the user left is the frame they return
  to.
- Deleted: the `session-switching` opacity dim, the session-loading skeleton
  path, the cross-session scroll/window/hydration resets inside
  `ChatTranscript`, the `100vh` hydration spacer, and the per-branch composer
  mount.
- Four invariants callers must keep:
  - **Cross-session events must not write the visible projection.** Background
    message, tool, and completion events update their own session's snapshot
    only; writing `messages` from a non-store-active session would paint another
    session's rows into the visible pane.
  - **Deleting a session must release its pane.** Removing a session drops its
    `retainedTranscripts` entry and its `retainedSessionIds` slot, so no pane
    outlives its session or holds a snapshot of deleted history.
  - **Leaving the chat with no active session must drop every pane.** Switching
    or clearing the project makes the retained sessions unreachable.
  - **A hidden pane performs no reading work.** Follow scrolling, history
    pagination, and row-position measurement all depend on a rendered scroller;
    a hidden pane's scroller reports `scrollTop === 0`, which reads as "at the
    top" and would page history for a session nobody is looking at.
- Per-session scroll retention **supersedes** the older rule that activation
  resets inherited manual-scroll state, for revisits: a revisited pane is
  expected to return to where the user left it.

## Alternatives considered

- **Replace `messages` with a per-session message map:** rejected.
- **Deep-equality reuse of the cached array:** rejected.
- **Keep the dim, only skip it when the cache is warm:** rejected.
- **Retain every visited session's pane:** rejected.
