# Test cases: history loading keeps the reading viewport

## Scope and prerequisites

- Requirements: request earlier history ahead of the top edge on upward scroll
  (`min(2400px, max(120px, 3 * clientHeight))`) without hiding overflow or
  blocking scroll input while tracking the newest actual message anchor; retain
  the brief scroll-input and `overflow-y: hidden` lock only for the `<= 120px`
  hard edge, explicit earlier-history actions, and underfilled top-boundary
  observer through IO and three stable layout frames; and drive return-to-latest
  through one custom interruptible `180–420ms` cubic ease-out viewport animation
  (immediate under reduced motion) that keeps visible messages mounted until
  arrival. Existing message, page, mounted-window, and retained-pane caches stay
  unchanged, with no idle TTL or memory reclamation.
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

## Start the controlled manual fixture

```bash
node scripts/e2e-transcript-history-loading.mjs --manual
```

The toolbar deliberately holds a page until **Complete page** or **Fail page**
is clicked. This makes the loading interval reproducible even on fast disks.
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
- Expected: while the hard-edge/explicit lock is active through IO and three
  stable layout frames, the same turn remains at the same screen position and
  main-scroller vertical wheel/touch/scroll-key input is discarded rather than
  queued; horizontal, zero-delta, and `Ctrl`+wheel input remain unaffected. The
  page lands above that turn without a visible jump. After settlement, new wheel
  input scrolls normally without draining to the oldest message at rest.
- Postcondition: earlier messages are available; the viewport is unlocked.

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

### TC-ERR-001: a failed page releases input

- Priority: High. Requirement: failure recovery does not leave a locked viewport.
- Steps: reset, start a held page, click **Fail page**, then scroll downward.
  Start another held page and click **Complete page**.
- Expected: loading ends without an immediate automatic retry loop. Input is
  released. A new upward reading gesture or earlier-history action can retry;
  only one page request is in flight at a time.

### TC-ST-001: explicit return-to-latest animates smoothly and overrides pending IO

- Priority: High. Requirement: one interruptible latest owner without blank frames.
- Steps: reset, start a held page, click the transcript's return-to-latest
  button, then click **Complete page**. Repeat from an ordinary tail and from a
  paginated historical view in both idle and running states, with normal motion
  and `prefers-reduced-motion: reduce`, and test interrupting mid-flight with
  main-scroller vertical wheel vs horizontal/zero/`Ctrl` wheel or nested/editable
  controls, plus hiding/switching panes mid-trip.
- Expected: with normal motion, the viewport animates smoothly (`180–420ms`
  cubic ease-out, monotonic without reversing, no empty message viewport frame)
  while suppressing competing follow, layout, and turn-completion owners;
  reduced motion reaches the bottom immediately. Preparing a historical view
  invalidates any pending page's `TranscriptView` identity (`loading: null`)
  without removing visible messages and clears that exact view only on arrival,
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
  1. Scroll upward into the ahead-loading band (`min(2400px, max(120px, 3 *
     clientHeight))`) and continue reading upward while cached rows mount first
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
  empty reads wait for a new gesture or explicit action). Only the `<= 120px`
  hard edge, explicit earlier-history continuation, or underfilled `120px`
  observer briefly holds main-scroller scroll input. Nested input, editable
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
two ahead-read prefetch cases (standalone user rows and mixed grouped answers
moving the same visible message `100px` during IO and staying within `2px` after
prepend), two quiet message-stability cases, and four pending/settled
latest-button cases. Boundary regressions also cross the prefetch threshold with
browser-native smooth travel, resume follow during pending IO, interrupt by a
press without a scroll and remount the saved message, start a delayed failed
search, and return from focused/restored disjoint ranges without forward paging.
Stream growth/completion, hide/unmount, and reduced-motion media emulation are
covered separately. Empty-view checks run after layout, before paint.

| Requirement | Cases | Evidence level |
| --- | --- | --- |
| Ahead-loading keeps scrolling unlocked and anchors prepends | TC-E-001 | Native wheel + `SessionPane` `100px` mid-IO / `<= 2px` prepend checks |
| Hard-edge fallback locks input without moving the reading point | TC-F-001, TC-F-002, TC-F-003 | Native Electron wheel + frame samples + delayed geometry |
| Failure or empty page releases lock without a retry loop | TC-ERR-001 | Real rejected/empty promises + native input |
| Smooth interruptible return-to-latest wins over pending IO | TC-ST-001 | Paired tail/paginated × idle/running `SessionPane` + unit tests |
| Existing controls and runtime state remain usable | TC-E-001 | Targeted suites + user application check |

Automated Windows results do not establish every hardware/OS combination.
Record the source revision, OS, display scaling and any remaining failing step
when reporting a manual result. Do not substitute scrollbar-thumb movement for
message stability: prepending legitimately changes the total scroll range.
