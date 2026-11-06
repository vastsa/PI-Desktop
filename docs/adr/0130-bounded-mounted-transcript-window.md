# ADR 0130: Bounded Mounted Transcript Window

- Status: Accepted
- Date: 2026-08-27
- Deciders: PI-Desktop core
- Related: D261, D269, E2E-159, ADR 0120, ADR 0127, D247, D258, D108,
  `04-ux/08-component-spec.md`
- Amended by: D269 (history continuation and boundary-driven escalation)

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
3. Window growth and a fetched page take the **same pre-paint message anchor**.
   The pane-local history paging hook captures the actual visible message's
   viewport offset (preferring a message node over an answer-group marker whose
   first id can change on prepend) and restores it before paint across committed
   projection and late row layout. Ahead-loading during upward scroll tracks the
   newest visible message anchor without hiding overflow or discarding input;
   only the hard-edge (`<= 120px`), explicit continuation, and underfilled
   top-boundary fallback briefly locks transcript scroll input and `overflow-y`
   through IO and three stable layout frames. Explicit latest navigation retires
   the prior gesture and hold so queued scroll events cannot start another read.
   This replaces the old `prependHeightRef` total-height delta: deferred DOM,
   tail updates, and intrinsic-size estimates made that delta unreliable.
4. The window **resets per session** and is clamped to the loaded history, so a
   grown budget inherited from the previous session for one frame cannot
   over-mount.
5. The hydration spacer stays **scoped to the first commit**. It exists to make
   the bounded bottom reachable; kept under the steady-state window it would put
   a blank viewport between the user and the growth trigger.
6. The conversation minimap's **message dashes** are built from the **mounted
   entries** (`transcriptEntryMessages`). It resolves a click by finding the
   marker's `data-minimap-id` node inside the scroller, so message markers for
   withheld rows would render dashes that jump nowhere.
6a. **Amended by D269.** Withheld history is represented explicitly instead of
   silently: while loaded rows sit above the window (`hiddenAbove > 0`) or the
   host reports an older page (`hasMoreBefore`), the rail stays mounted and shows
   one dotted earlier-history continuation, even when the mounted tail has fewer
   than two message markers or does not overflow one viewport. The continuation
   runs the same two-stage escalation as clause 2, so it is always actionable;
   D108's two-marker-plus-overflow rule resumes once no earlier history remains.
6b. **Amended by D269.** Hard-edge escalation is driven by the visibility of the
   transcript's top loading boundary as well as by the `120px` near-top check;
   there is no early-threshold observer and no eager page draining at rest. An
   underfilled tail page, a fetched page whose rows all fall outside the mounted
   window, and a window transition can each leave `scrollTop` unchanged; without
   that `120px` observed boundary those states stalled upward travel and left
   the outline hidden.
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

## Implementation notes

- **Gesture-driven ahead-loading vs. hard-edge lock:** A real upward scroll
  gesture within `min(2400px, max(120px, 3 * clientHeight))` starts single-flight
  escalation in the background, still mounting cached withheld rows before
  requesting a Host page. Background escalation leaves `overflow-y` and main
  scroll input unlocked, updates its actual-message reading anchor as the user
  continues scrolling, and subtracts observed scroll displacement from its
  viewport offset before correcting geometry changes. This preserves compositor
  movement even when lazy rows lay out before their scroll event. Reaching `<= 120px`,
  invoking the earlier-history continuation, or intersecting the `120px` top
  boundary retains the brief input/`overflow-y: hidden` lock through IO and
  three consecutive stable layout frames. Failed or empty reads release any lock
  and wait for a new scroll gesture or explicit earlier-history action.
- **Interruptible return-to-latest:** Returning to latest uses one custom
  viewport animation (`180–420ms` cubic ease-out, monotonic retargeting across
  late stream growth; immediate under `prefers-reduced-motion: reduce`) instead
  of browser smooth scroll, suppressing competing follow, layout, previous
  search-alignment, and turn-completion scroll owners while active. A new search
  request still cancels the trip. Genuine main-scroller input
  cancels the animation in place without committing arrival; horizontal,
  zero-delta, or `Ctrl`+wheel input and nested scrollers, editable fields, or
  row controls do not. Preparing return-to-latest from a historical
  `transcriptViews` slice replaces its identity with `loading: null` while
  keeping current messages mounted, clears that exact prepared view only on
  arrival, and commits on pane hide or unmount; disjoint search/history ranges
  join the canonical live tail on arrival without fetching or animating unloaded
  intermediate ranges. Runtime `isRunning` state passed to scroll hooks stays
  real rather than faked stopped by a historical view.
- **Cache invariants:** Existing message, page, mounted-window, recent snapshot,
  and retained session-pane caches are unchanged; no idle TTL or memory
  reclamation is introduced.
