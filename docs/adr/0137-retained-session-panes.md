# ADR 0137: Retained Session Panes

- Status: Accepted
- Date: 2026-08-30
- Deciders: PI-Desktop core
- Related: D162, D261, D317, ADR 0120, ADR 0127, ADR 0130, D142,
  `04-ux/08-component-spec.md` §3.5 / §7, `04-ux/09-interaction-patterns.md` §5,
  E2E-011, E2E-071d, E2E-071g, E2E-177
- Amends: D162 (the dimmed keep-alive frame), ADR 0130 clause 4 and clause 5
  (per-session window reset and first-commit hydration), D162's
  "activation resets manual-scroll state" rule for revisits

## Context

D162 already avoided the worst session-switch artifact: it kept the last settled
transcript mounted instead of tearing it down to a skeleton. The switch still
flashed, because keeping *a* transcript mounted is not the same as keeping *the
destination's* transcript mounted.

The store held one `messages: UiMessage[]` for the active session, and a switch
replaced that array wholesale. One `ChatTranscript` instance served every
session, so on a `sessionId` change it had to reset its scroll position, its
mounted-row window, and its hydration state by hand, and every row remounted
because row keys are message-scoped. Markdown was reparsed and Shiki retokenized
for a transcript the user had read a moment earlier.

Three visible costs followed:

- The kept frame was **dimmed** (`opacity: .82`, `pointer-events: none`) under a
  thin progress track. On a warm revisit the destination content was already in
  renderer memory, so the dim was a wait animation for work that did not need to
  happen.
- **Scroll position was not the pane's**. A single scroller cannot hold two
  reading positions, so returning to a session the user had scrolled up in
  restarted at the bottom, and the reset had to be explicit to avoid inheriting
  the *previous* session's offset instead.
- The **two-stage progressive hydration** of ADR 0130 clause 5 ran on every
  switch: mount the trailing 15 rows for one frame behind a `100vh` spacer, then
  expand in a rAF and re-anchor. It exists only because the component instance is
  shared, and it is the machinery most able to produce the jump it is there to
  prevent.

## Decision

1. `ChatSurface` mounts one **`SessionPane` per retained session id**, keyed by
   session id. A pane owns its transcript DOM, its scroll position, and its
   mounted-row window for its whole lifetime, so a switch is a visibility swap,
   not a rebuild.
2. Retention is a **bounded LRU of 3 panes**: the visible one plus the two most
   recently visited. `retainedSessionIds` holds that order in the store and
   eviction unmounts the oldest pane.
3. An inactive pane stays mounted, hidden with `visibility: hidden` +
   `content-visibility: hidden`, `aria-hidden`, and non-interactive. It is
   explicitly **not** `display: none`: that destroys the layout box, which is
   what holds `scrollTop`, so hiding by display would reset every retained
   reading position and defeat the whole decision.
4. `messages` remains the **live projection of the store-active session**. The
   store adds a bounded per-session snapshot record, `retainedTranscripts`. A
   pane renders `messages` when its session is the store-active one, and its own
   snapshot otherwise, so no pane ever renders another session's rows.
5. A **warm switch** — the destination already has a retained pane — reveals that
   pane immediately from its retained content. The first frame is already
   correct: no dim, no skeleton, no remount. The revalidated transcript lands in
   the same pane afterwards with no visible change. If the destination is still
   running, that revalidation stitches the bounded durable page onto the live
   snapshot in chronological order (older live rows before the page, in-flight
   tail after it) so D261's trailing mounted window still shows the newest turn
   (D317).
6. A **cold switch** — no retained pane — keeps the currently visible pane
   showing its own session until the destination commits. Only the thin progress
   track marks the wait. The opacity dim is removed entirely.
7. **Scroll retention is per pane.** A pane restores its own position when it
   becomes visible again: a pane still pinned re-anchors to the bottom, a pane
   the user had scrolled up in returns to that offset. First activation of a
   session still settles at its newest turn.
8. The **first commit is per pane and local**. Because the component instance
   belongs to one session, "the first commit of this pane" is plain mount state;
   the cross-session hydration spacer, its rAF expansion, and its re-anchor are
   deleted. ADR 0130's trailing window, two-stage escalation, and prepend anchor
   are unchanged inside a pane.
9. The **composer is mounted once** for the whole chat surface rather than once
   per branch — it already carries a per-session draft cache. It stays
   non-interactive while the visible pane is not yet the store-active session, so
   a prompt cannot be sent to the session being left.

No IPC, storage, host protocol, or pagination change. Transcript reads, the
latest-wins navigation generation, and the five-snapshot transcript cache of D162
are untouched; panes are a renderer-side presentation bound, not a second cache.

## Consequences

- Retained renderer memory grows by at most two extra mounted transcripts, each
  itself bounded by ADR 0130's window. The ceiling is the pane budget times the
  window, not the number of sessions visited.
- A revisit within the budget costs no Markdown parse, no Shiki tokenization, and
  no scroll correction — the frame the user left is the frame they return to.
- Deleted: the `session-switching` opacity dim, the session-loading skeleton
  path, the cross-session scroll/window/hydration resets inside `ChatTranscript`,
  the `100vh` hydration spacer, and the per-branch composer mount.
- Four invariants callers must keep:
  - **Cross-session events must not write the visible projection.** Background
    message, tool, and completion events update their own session's snapshot
    only; writing `messages` from a non-store-active session would paint another
    session's rows into the visible pane. This is the same boundary D142 draws
    for work-panel contexts.
  - **Deleting a session must release its pane.** Removing a session drops its
    `retainedTranscripts` entry and its `retainedSessionIds` slot, so no pane
    outlives its session or holds a snapshot of deleted history.
  - **Leaving the chat with no active session must drop every pane.** Switching
    or clearing the project makes the retained sessions unreachable. Because the
    visible pane is the head of the retained order, a pane left behind would keep
    the previous project's conversation on screen and suppress the empty state.
  - **A hidden pane performs no reading work.** Follow scrolling, history
    pagination, and row-position measurement all depend on a rendered scroller;
    a hidden pane's scroller reports `scrollTop === 0`, which reads as "at the
    top" and would page history for a session nobody is looking at. Hidden panes
    keep their DOM and their offset, and nothing else.
- Per-session scroll retention **supersedes** the older rule that activation
  resets inherited manual-scroll state, for revisits: a revisited pane is
  expected to return to where the user left it. First activation is unchanged and
  still settles at the newest turn, and no pane may ever show another session's
  offset.
- An evicted session behaves like a cold open. This is intentional and must stay
  indistinguishable from a first visit rather than surfacing an error or an empty
  frame.

## Alternatives considered

- **Replace `messages` with a per-session message map:** rejected. It moves the
  same wholesale swap one level down — a single transcript instance still reads
  one entry at a time, so the row remount, the Markdown rebuild, and the shared
  scroller all survive. The flash is a component-identity problem, not a store
  shape problem.
- **Deep-equality reuse of the cached array:** rejected. Making a revalidated
  read reference-equal to the cached array suppresses one re-render but leaves
  the destination sharing one instance with the session being left, so the first
  frame after a switch is still built from scratch. It also pays a deep walk over
  the transcript on every revalidation to save work the pane already saves
  structurally.
- **Keep the dim, only skip it when the cache is warm:** rejected. The dim was
  never the affordance for a warm switch; a correct destination frame is. Keeping
  it as a conditional leaves two switch appearances to reason about and two
  states to test, for a wait that the retained pane has already removed. The
  thin progress track is enough for the cold case.
- **Retain every visited session's pane:** rejected. Unbounded panes reintroduce
  exactly the unbounded retention ADR 0130 removed, on a low-memory machine that
  reported the chat area degrading. Three panes cover the observed
  switch-and-return pattern; the fourth is a cold open.
