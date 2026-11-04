# Test cases: history loading keeps the reading viewport

## Scope and prerequisites

- Requirements: discard transcript scrolling while earlier messages load; keep
  the current visible turn stationary through paging and late layout; restore
  normal input afterwards without changing other navigation.
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

### TC-F-001: continuous wheel input during a slow page

- Priority: High. Requirement: no jump to the beginning during loading.
- Preconditions: start the fixture and click **Reset conversation**.
- Steps:
  1. Click **Load earlier (hold)**. Note the turn label and its position.
  2. Keep the pointer over the transcript and continuously roll upward for at
     least five seconds. Repeat downward and with trackpad momentum if present.
  3. Click **Complete page** and immediately try scrolling again.
- Expected: while loading, the same turn remains at the same screen position;
  no input accumulates for replay. The page lands above that turn without a
  visible jump. After loading ends, new wheel input scrolls normally through
  older messages; it must not drain to the oldest message on its own.
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

### TC-ST-001: explicit return-to-latest overrides the pending page

- Priority: High. Requirement: existing navigation retains ownership.
- Steps: reset, start a held page, click the transcript's return-to-latest
  button, then click **Complete page**.
- Expected: navigation reaches and stays at the latest turn. The old page must
  not pull the viewport back to its former reading anchor or keep input locked.
  Repeat via the real session/store paging path, both immediately after the
  upward gesture while a page is pending and after the page settles, using
  standalone rows and a continuous grouped answer. Keep normal motion enabled.
  No queued scroll event may reopen history or start another older-page read.

### TC-E-001: verify the real application paths

- Priority: High. Use an application built from this checkout with a long local
  conversation containing several historical pages, tool output and code.
- Steps:
  1. Repeat TC-F-001 and TC-F-002 while entering earlier turns normally by
     scrolling upward, including already-loaded window growth and fetched pages.
  2. While a page loads, scroll a nested tool/delegate panel; use an editable
     field and activate a focused title with Space. Try horizontal code scrolling.
  3. Navigate with minimap/search, expand a tool, or return to latest. Switch to
     another conversation and back. Repeat at a narrower window width.
  4. Send a new prompt, scroll up while it streams, return to latest and stop.
- Expected: only the main transcript's loading-period scroll input is held.
  Nested input, editable keys, title activation and zoom still work. Explicit
  navigation, session reading positions, streaming follow and Stop are unchanged.
- Note: use local historical data; a paid/live-provider turn is a user opt-in,
  not required by the deterministic automated fixture.

## Automated coverage

```bash
node scripts/e2e-transcript-history-loading.mjs
node scripts/e2e-transcript-reading-position.mjs
node scripts/e2e-transcript-minimap-jump.mjs
node scripts/e2e-transcript-disclosure-anchor.mjs
node scripts/e2e-transcript-turn-completion.mjs
```

The history-loading script is also included in `e2e-transcript-render.mjs`.
It sends real Electron wheel events, uses an explicit page completion boundary,
checks single-flight IO, samples the visible anchor each frame (2 CSS-pixel
rounding tolerance), and checks normal input after completion. Cases include
quiet loading, native wheel bursts, tail updates, six successive delayed row
height changes, rejection, empty pages, cached-window growth, hide/reveal, input
ownership and return-to-latest. Its additional `transcript-history-navigation`
journey uses production `SessionPane`, the real store and delayed external Host
IPC reads: two message-stability cases (standalone/grouped) plus four real
latest-button cases (pending/settled page × standalone/grouped). It checks the
historical view is cleared, the bottom remains reached and no extra page starts.

| Requirement | Cases | Evidence level |
| --- | --- | --- |
| Loading input does not move the reading point | TC-F-001 | Native Electron wheel + manual |
| Loading/rendering does not jitter | TC-F-002 | Frame samples + delayed geometry |
| Failure releases input without a retry loop | TC-ERR-001 | Real rejected promise + native input |
| Explicit navigation wins over a late page | TC-ST-001 | Production return-to-latest action |
| Existing paths remain usable | TC-E-001 | Targeted suites + user application check |

Automated Windows results do not establish every hardware/OS combination.
Record the source revision, OS, display scaling and any remaining failing step
when reporting a manual result. Do not substitute scrollbar-thumb movement for
message stability: prepending legitimately changes the total scroll range.
