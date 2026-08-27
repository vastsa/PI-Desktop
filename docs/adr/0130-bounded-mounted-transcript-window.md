# ADR 0130: Bounded Mounted Transcript Window

- Status: Accepted
- Date: 2026-08-27
- Deciders: PI-Desktop core
- Related: D261, E2E-159, ADR 0120, ADR 0127, D247, D258,
  `04-ux/08-component-spec.md`

## Context

ADR 0120 bounded the transcript payload that crosses the IPC boundary, and
ADR 0127 / D258 bounded the cost of locating a page inside the JSONL file. Both
addressed session *activation*. Neither bounded what the renderer keeps mounted
afterwards.

The renderer mounted every history row it had paged in and kept it mounted for
the life of the session. Scrolling up through a long conversation therefore
accumulated, without any ceiling:

- React element trees for every row,
- a parsed Markdown AST per settled block,
- Shiki `LineCache` token arrays per code fence,
- the DOM nodes themselves.

`.message-row` and `.tool-activity-group` already carry
`content-visibility: auto`, which skips layout and paint for far-offscreen rows.
That is a CPU optimization and explicitly not a memory one: the retained
JavaScript and DOM stay live. On a low-memory Windows machine — where the chat
area was reported as getting progressively less responsive as a session grew —
retained memory and the GC pressure behind it are the binding constraint.

A second cost was per-frame. `TranscriptHistory`'s memo comparator walks every
mounted entry, part, and activity item whenever its props array is not
reference-equal, and that runs on every streamed token.

## Decision

1. The mounted history is a **trailing window** over the loaded history, not all
   of it. `reduceTranscriptWindow` resolves the slice for one render:
   `TRANSCRIPT_INITIAL_MOUNT` (15) rows for the first commit after a session
   switch, `TRANSCRIPT_WINDOW_MIN` (60) in steady state.
2. Reaching the top **escalates in two stages**. `growTranscriptWindow` adds
   `TRANSCRIPT_WINDOW_STEP` (40) rows while the window is partial; only once the
   window covers all loaded history does the transcript call `loadOlder` and
   fetch an older page. Mounting what is already loaded is strictly cheaper than
   an IPC round trip, so it goes first.
3. Window growth and a fetched page take the **same pre-paint scroll anchor**.
   Both add height above the reading position, so `prependHeightRef` is captured
   for both and corrected in the same layout effect.
4. The window **resets per session** and is clamped to the loaded history, so a
   grown budget inherited from the previous session for one frame cannot
   over-mount.
5. The hydration spacer stays **scoped to the first commit**. It exists to make
   the bounded bottom reachable; kept under the steady-state window it would put
   a blank viewport between the user and the growth trigger.
6. The conversation minimap is built from the **mounted entries**
   (`transcriptEntryMessages`). It resolves a click by finding the marker's
   `data-minimap-id` node inside the scroller, so markers for withheld rows would
   render dashes that jump nowhere.
7. The entry projection arrays are memoized on `entries`, so a re-render that
   changed no message hands `TranscriptHistory` a reference-equal array and its
   comparator bails on identity instead of deep-walking the mounted rows.

No IPC, storage, host protocol, or pagination change. `SESSION_TRANSCRIPT_PAGE_SIZE`
and the `session.get` window contract are untouched.

## Alternatives considered

- **Rely on `content-visibility` alone:** rejected. It was already in place and
  is what makes the *unbounded* case survivable at all, but it retains every
  row's React tree, Markdown AST, and token arrays. It cannot bound the resource
  the low-memory report is about.
- **Full virtualization with measured row offsets:** rejected for now. Transcript
  rows have highly variable, content-dependent heights that change after mount
  (streaming, disclosure toggles, lazy Mermaid), so a measured-offset virtualizer
  needs a height cache and invalidation for all of it. The trailing window gets
  the same memory ceiling with a fraction of the moving parts, and the existing
  pinned-follow and prepend-anchor logic keeps working unchanged.
- **Unmount by distance from the viewport in both directions:** rejected. The
  transcript is read from the bottom and streams at the bottom; withholding rows
  *below* the viewport would fight pinned-follow for no benefit.
- **Cap the loaded history instead, discarding older pages from the store:**
  rejected. It would make paging non-monotonic and re-fetch rows the user just
  scrolled past, and the store's transcript is also read by the outcome card and
  full-history rewrite paths.
- **Reduce the per-frame comparator cost by making projections referentially
  stable:** kept only in its cheap form (memoizing the arrays). Reconciling
  per-turn object identity across rebuilds was rejected as complexity that the
  bounded window already makes unnecessary — the comparator now walks at most the
  window, not the history.

## Consequences

- Retained renderer memory for a transcript is bounded by the window rather than
  by how far back the user has scrolled, and per-frame reconciliation during
  streaming is bounded with it.
- Upward travel through a long session costs one frame per growth step before
  pagination resumes. Each step is a mount of already-loaded rows, so it does not
  add IPC.
- The browser's native find-in-page reaches only mounted rows. This is a real
  narrowing of an incidental capability; in-app search over the full transcript is
  unaffected because it does not depend on mounted DOM.
- Newly mounted rows briefly use the `contain-intrinsic-size` fallback height
  before their real size is known, so the scrollbar thumb settles as they enter
  view. This is the pre-existing `content-visibility` behavior, unchanged in kind
  by windowing.
