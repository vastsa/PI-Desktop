# Test cases: history loading keeps the reading viewport

## Scope and prerequisites

- Requirements: request earlier history ahead of the top edge on upward scroll
  (base `min(2400px, max(120px, 3 * clientHeight))`, increased by speed times
  measured read latency plus `150ms`, capped at twelve screens or `12000px`)
  without hiding overflow or blocking input. All paths, including the hard edge
  and explicit continuation, track the moving actual-message anchor through IO
  and three stable layout frames. Drive return-to-latest
  through browser-native smooth scrolling like the conversation turn markers
  (`auto` under reduced motion), keeping visible messages mounted until native
  arrival. Tail-connected loaded pages and cursors remain available, independently
  of mounted-window bounds; no idle TTL or memory reclamation is introduced.
- Follow-up integration base: official `vastsa/PI-Desktop` main,
  `14b928f3171e9e00b6d2851d67c832812ff61fc7`, including merged PR #2080.
  The continuous-answer jump and pending-page latest-button race both fail on
  this baseline despite the original seven direct-component cases passing.
- The original failing reproduction was verified on official main
  `3f8c02c63e6ca6ed9ff0c9c570cfc4aeadea92cd`.
- Run from this request checkout, not another installed Desktop build. Existing
  compatible dependencies and a fresh Desktop build are required. The fixture
  opens a separate Electron window, uses temporary data and synthetic messages,
  and never reads real sessions or contacts a provider.
- Close the fixture window to exit and remove its temporary profile.

## Full PI-Desktop manual session

For the complete application (sidebar, project, transcript and Composer), run:

```bash
node scripts/manual-transcript-desktop.mjs
```

Set `PI_SCRATCH_DIR` to an isolated test directory first. A current Desktop build
and Host binary are required; `PI_DESKTOP_HOST_BIN` can select that binary.
The launcher creates a new database, profile and user home under scratch, then
uses Host RPC to seed **Scroll test — 1000 messages** and
**Scroll test — long answers** (80 messages, with a 1,600-paragraph final answer).
Select either session in the normal sidebar. Scroll quickly in both directions,
click the down-arrow, resize the window, and switch away and back. Pagination
uses the real Host database rather than the held-page component fixture below.
No model provider is configured; this fixture is for reading/navigation, not
sending model requests. Test data and screenshots remain in the printed scratch
directory. Exit using the application's normal Quit action.

`node scripts/manual-transcript-desktop.mjs --smoke` verifies seeded sidebar,
transcript and Composer readiness, captures a screenshot, and quits only its
own newly launched instance through the normal application IPC and its quit
confirmation dialog. `--interaction-smoke` additionally sends native wheel
input until the mounted window crosses the initial 100-message Host page,
asserts that fewer than 1,000 rows are mounted, clicks the real return-to-latest
button, and checks visible rows on every sampled navigation frame and at most
`2px` of tail drift during the 600ms after arrival. It writes `interaction.json`
and exits normally. These checks complement, rather than replace, the held-IO
component fixture's prepend-anchor and request-concurrency measurements.

## Stable reading after page settlement

`node scripts/e2e-transcript-history-loading.mjs --anchor-only` runs the targeted
late-reading regressions. It first loads a page through production ChatTranscript,
then waits for settlement before changing the layout: content above grows 120px;
a balanced case also shrinks content below by 120px; a long-answer case grows
an earlier paragraph within the same message. Nonempty layout samples remain
within 1px, and six 20px steps require identical captured text pixels. There is
no loading veil, delayed reveal, input cancellation, or final-position-only check.
The full suite still exercises native wheel/smooth travel and navigation handoff.
The full application's `--interaction-smoke` also checks a painted reading crop
after real Host pagination. These checks do not change page-cache lifetime.

## Start the controlled manual fixture

```bash
node scripts/e2e-transcript-history-loading.mjs --manual
```

The fixture offers 1,000 synthetic messages, initially loading only the newest
40. Each successful page adds up to 100 older messages. The status line shows
requests and loaded/unloaded counts; **Reset conversation** restores the initial
40 messages. The toolbar deliberately holds a page until **Complete page** or
**Fail page** is clicked, making delay reproducible even on fast disks.

Scroll normally to trigger prefetch, or use **Load earlier (hold)** to traverse
cached row-window expansion until a physical page request starts. While it is
pending, scroll rapidly in either direction or click the transcript's down-arrow
to return to latest. Then complete the page: the old request must not pull the
viewport back. Repeat with failure and retry. Closing the window ends the test;
no real session, provider configuration, or user database is changed.

For an automated check of the same toolbar and two delayed pages, run:

```bash
node scripts/e2e-transcript-history-loading.mjs --manual-smoke
```

This also sends 24 native wheel events in each direction during each pending
page, checks directional movement and single-flight requests, and reports rAF
frame-gap p95/max (p95 budget: 100ms). These measurements cover this fixture and
machine, not arbitrary hardware or a guarantee of zero frame delay.
The actual production `ChatTranscript`, scroll hooks, Markdown and stylesheet
are used. It is not a mock implementation of scrolling.

### TC-F-001: continuous wheel input during a slow hard-edge / explicit page

- Priority: High. Requirement: hard-edge fallback prevents jumping to the top.
- Preconditions: start the fixture and click **Reset conversation**.
- Steps:
  1. Click **Load earlier (hold)** (hard-edge / explicit fallback). Note the
     turn label and its position.
  2. Keep the pointer over the transcript and continuously roll upward for at
     least five seconds. Repeat downward and with trackpad momentum if present.
  3. Click **Complete page** and immediately try scrolling again.
- Expected: wheel/touch/scroll-key input moves the reading point during IO;
  neither overflow hiding nor input cancellation freezes the viewport. The page
  lands above the resulting reading point without adding a visible jump. With
  no input, the same message stays within `2px`. Horizontal, zero-delta and
  `Ctrl`+wheel input remain unaffected. No eager history drain occurs at rest.
- Postcondition: earlier messages are available and input remains usable.

### TC-F-002: no-input loading has no vertical jitter

- Priority: High. Requirement: no up/down movement without input.
- Steps: reset, start a held page, leave the mouse still for five seconds, note
  the visible turn, then click **Complete page** without using the wheel.
- Expected: the turn does not move when the loading label appears, while the
  page is pending, when rows mount, or when the label disappears. Repeating the
  case must not produce alternating small jumps.

### TC-F-003: a continuous answer spanning a page stays stationary

- Priority: High. Requirement: pagination must not anchor a temporary group.
- Use the automated `SessionPane` journey below, or a local conversation with
  several consecutive assistant messages in one answer spanning a page edge.
- Steps: scroll into the oldest loaded fragment and trigger an earlier page;
  identify a visible paragraph, then allow the preceding answer fragments to load.
- Expected: that same message stays at its screen offset even when its enclosing
  answer group's first message changes. Do not assess only `scrollTop` or the
  outer group's position. Repeat with ordinary standalone user rows.

### TC-ERR-001: a failed page preserves input

- Priority: High. Requirement: failure recovery preserves the usable viewport.
- Steps: reset, start a held page, click **Fail page**, then scroll downward.
  Start another held page and click **Complete page**.
- Expected: loading ends without an immediate automatic retry loop. Input stays
  usable. A new upward reading gesture or earlier-history action can retry;
  only one page request is in flight at a time.

### TC-ST-001: explicit return-to-latest animates smoothly and overrides pending IO

- Priority: High. Requirement: one interruptible latest owner without blank frames.
- Steps: reset, start a held page, click the transcript's return-to-latest
  button, then click **Complete page**. Repeat from an ordinary tail and from a
  paginated historical view in both idle and running states, with normal motion
  and `prefers-reduced-motion: reduce`, and test interrupting mid-flight with
  main-scroller vertical wheel vs horizontal/zero/`Ctrl` wheel or nested/editable
  controls, plus hiding/switching panes mid-trip.
- Expected: normal motion uses browser-native smooth scrolling with the same
  browser-owned timing as turn markers, no instantaneous intermediate position
  writes, and no empty message viewport frame. Competing follow, layout, and
  turn-completion owners yield until native completion; reduced motion uses
  immediate `auto`. Preparing history invalidates pending page ownership without
  removing visible messages; arrival exits historical ownership but retains connected pages,
  while pane hide or unmount commits the accepted latest intent once. Genuine
  main-scroller input cancels the trip at its current offset without committing
  arrival; horizontal, zero-delta, and `Ctrl`+wheel input and nested/editable/row
  controls do not. Disjoint search or history views switch to the canonical live
  tail on arrival and may skip unloaded intermediate ranges without fetching or
  animating them. No queued scroll event reopens history or starts another read.

### TC-E-001: verify ahead-loading and real application paths

- Priority: High. Use an application built from this checkout with a long local
  conversation containing several historical pages, tool output and code.
- Steps:
  1. Scroll upward into the adaptive ahead-loading band; repeat fast travel from
     `4000px` above the boundary. Continue reading while cached rows mount first
     and Host pages load in the background; then scroll all the way into the
     `<= 120px` hard edge. Leave the viewport at rest in the ahead-loading band.
  2. During both ahead-loading and a hard-edge load, scroll a nested
     tool/delegate panel, type in an editable field, activate a focused title
     with Space, and try horizontal code scrolling and `Ctrl`+wheel zoom.
  3. Navigate with minimap/search, expand a tool, or return to latest. Switch to
     another conversation and back. Repeat at a narrower window width.
  4. Send a new prompt, scroll up into history while it streams, verify runtime
     running state stays real without re-pinning the historical view, then
     return to latest and stop.
- Expected: ahead-loading stays single-flight, leaves `overflow-y` and main
  scroll input unlocked, tracks the newest actual message anchor as the user
  keeps scrolling, corrects insertions/layout before paint without visible jump,
  and never eagerly drains pages at rest (no early-threshold observer; failed or
  empty reads wait for a new gesture or explicit action). The `<= 120px`
  hard edge, explicit continuation and underfilled observer use the same unlocked
  behavior. Nested input, editable
  keys, title activation, horizontal/zero/`Ctrl` wheel, explicit navigation,
  session reading positions, streaming follow, and Stop remain intact.
- Note: use local historical data; a paid/live-provider turn is a user opt-in,
  not required by the deterministic automated fixture.

## Automated coverage

```bash
node --test apps/desktop/test/transcript-latest-navigation.test.mjs apps/desktop/test/transcript-reading.test.mjs apps/desktop/test/transcript-scroll.test.mjs
node scripts/e2e-transcript-history-loading.mjs
node scripts/e2e-transcript-reading-position.mjs
node scripts/e2e-transcript-minimap-jump.mjs
node scripts/e2e-transcript-disclosure-anchor.mjs
node scripts/e2e-transcript-turn-completion.mjs
```

The history-loading script is also included in `e2e-transcript-render.mjs`.
It sends real Electron wheel events, uses an explicit page completion boundary,
checks single-flight IO, samples the visible anchor each frame (2 CSS-pixel
rounding tolerance), and checks normal input after completion. Direct fixture
cases retain quiet hard-edge loading, native wheel bursts, tail updates, six
successive delayed row height changes, rejection, empty pages, cached-window
growth, hide/reveal, input ownership, and return-to-latest during IO, plus
unlocked ahead-loading with native wheel movement (`beginAhead`). Its
`transcript-history-navigation` probe uses production `SessionPane`, the real
store, and delayed external Host IPC reads: four paired return-to-latest motion
cases (ordinary tail vs paginated history × idle vs running, asserting `>= 3`
intermediate frames, reversal `<= 2px`, and zero empty visible-message frames),
  ahead-read cases (standalone user rows, mixed grouped answers, a preceding
  message growing `400px` after input, and adaptive prefetch from `4000px`). All move the
same visible message `100px` during IO and stay within `2px` after prepend;
the delayed predecessor must not replace a still-visible original anchor.
There are also two quiet message-stability cases and four pending/settled
latest-button cases. Boundary regressions also cross the prefetch threshold with
browser-native smooth travel, resume follow during pending IO, interrupt by a
press without a scroll and remount the saved message, start a delayed failed
search, and return from focused/restored disjoint ranges without forward paging.
Stream growth/completion, hide/unmount, and reduced-motion media emulation are
covered separately. Latest navigation also tests `2400px` growth above the
reader, with unit coverage for `1200px` shrinkage. History-release drift excludes
legitimate final animation travel. Empty-view and delayed-layout stability
checks require nonempty layout-complete/prepaint samples (`<= 2px`), retaining
pre-layout rAF diagnostics separately. A 1,035-message fixture traverses three
physical pages through the production cached-window escalation, moves the same
message `100px` during each read, checks `<= 2px` insertion drift, descending
100-message cursors, single-flight reads and no extra read after settlement.
It records mounted-message counts as a baseline; this programmatic-position
journey is not a native high-speed throughput or bounded-resource guarantee.

| Requirement | Cases | Evidence level |
| --- | --- | --- |
| Ahead-loading keeps scrolling unlocked and anchors prepends | TC-E-001 | Native wheel + `SessionPane` `100px` mid-IO / `<= 2px` prepend checks |
| Hard-edge fallback preserves input and anchors the new reading point | TC-F-001, TC-F-002, TC-F-003 | Native Electron wheel + layout-complete samples + delayed geometry |
| Failure or empty page ends without a retry loop | TC-ERR-001 | Real rejected/empty promises + native input |
| Smooth interruptible return-to-latest wins over pending IO | TC-ST-001 | Paired tail/paginated × idle/running `SessionPane` + unit tests |
| Existing controls and runtime state remain usable | TC-E-001 | Targeted suites + user application check |

Automated Windows results do not establish every hardware/OS combination.
Record the source revision, OS, display scaling and any remaining failing step
when reporting a manual result. Do not substitute scrollbar-thumb movement for
message stability: prepending legitimately changes the total scroll range.
