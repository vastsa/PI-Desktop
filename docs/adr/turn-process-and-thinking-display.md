# ADR turn-process-and-thinking-display: Turn process and thinking presentation

- Status: Accepted
- Date: 2026-09-17
- Amended: 2026-10-22
- Issues: #510, #461, #1806
- Amends: D071, [ADR 0242](0242-delta-only-streaming-updates.md)

## Context

A model can alternate reasoning, tool calls and progress text many times before
answering one user request. Separate activity groups leave those progress
messages at the same visual level as the answer, while one flat process
container still leaves long tool/search sequences difficult to scan. Some
readers also need a thinking indicator without rapidly changing reasoning text.

## Decision

One unified turn-process presentation applies to every loaded assistant-turn
entry: it projects the entry into one collapsible process disclosure plus its
trailing answer. Thinking, tools, intermediate assistant text and the turn's
`Bash` run rows keep their original order inside that disclosure. A trailing
assistant text stays visible
while streaming; if later tool or thinking activity follows, that text moves into
the process without changing the stored message. There is no semantic
final-answer marker in `UiMessage`, so the renderer does not guess intent from
wording. User/system messages and compaction dividers retain their existing turn
boundaries.

One turn renders exactly one process disclosure. Every row the turn produced
before its answer lives inside it — the activity groups and the `Bash` run rows
alike — so a long turn collapses in one gesture instead of leaving a column of
sibling disclosures above the answer. The answer itself stays outside it. An
untouched process closes when the turn completes, so only the final answer
remains; when the turn produced no final text, the process header and its error
or pending-action surfaces remain visible.

Inside that disclosure, the display mode decides how activity is grouped.
`AppSettings.transcriptDisplayMode` is one of `flat`, `command-first`, or
`fully-folded`; an absent or unknown value resolves to `fully-folded`, the
layout released in v0.20.0. Every mode renders exactly one outer disclosure.

- In `fully-folded`, contiguous activity forms ordinary activity groups: one
  contiguous tool/search/thinking/Bash segment between ordinary assistant
  progress paragraphs. A `Bash`/run row stays inside the group around it, so a
  command reads as another line of that group. Existing Task topology remains
  its segment's container and is not duplicated inside an ordinary activity
  group.
- In `command-first`, ordinary activity groups still render, but every
  `Bash`/run alias is lifted out as a standalone row beside them: adjacent calls
  stay separate and a row's detail stays closed until the user opens it. A
  normal assistant progress message and a command both end the current group.
- In `flat`, no nested activity groups render at all. The outer disclosure lists
  active tools, commands, thinking and progress rows in transcript order, with
  tool details collapsed.

In `command-first` and `fully-folded`, a group appears only when at least two
items are visible under the current thinking preference. A singleton uses its
item disclosure directly, and hidden thinking does not create a redundant
wrapper.

`keepCommandsExpanded` is deprecated. It is retained only so persisted settings
still load, is no longer exposed in Settings, and is not read for rendering; new
writes store `transcriptDisplayMode`.

Group folding defaults are unified across modes. Every ordinary group of a turn
stays open while that turn is active, whether or not it still owns the live
segment, so work never folds away mid-run. After the turn settles, ordinary
groups with at most four visible items stay open, larger groups of plain tool
rows start closed, and Task topology groups stay open. A group that still renders
a Thinking row stays open too: with `Show thinking` on the reasoning is content
the reader asked to see. Tool, search and run-row payloads keep their own closed
defaults. Explicit user choices remain authoritative.

The turn's disclosure header states the turn's outcome and carries only its
bounded metadata: status, recorded duration and direct tool/search count. It
never echoes the item it is working on, because a shell command or search query
can be arbitrarily long. It reads `failed`, `stopped`, `running`, or finished, in
that precedence: a recorded failure outranks a stop, because the turn produced no
answer and a normal-looking header hid that. A stop is read from an aborted
message, the only signal the runtime records — the turn result distinguishes
completed from failed only. Aborted activity rows also record a stop while a tool
or reasoning step is in flight; delegated child rows do not determine the parent
turn's outcome. While running, stages a reader can sit in front of (compaction,
recovery) name themselves; a live reasoning step reads `Thinking`, and momentary
stages read as plain running. Durations are dropped when the transcript recorded
no timing rather than shown as zero. Issue counts are not repeated here: a
failure is already named by the status itself. The header is a full-width row
separated by a hairline; status, duration, tool count and the disclosure caret
form one left-aligned run, so the caret trails the metadata instead of sitting at
the far edge of the band. Hovering strengthens the text colour only and never
paints a background.

The disclosure and its group headers share one left edge. A nested activity
group keeps the released v0.20.1 hierarchy below that header: its body indents
child rows by 12px, with the group's collapse rail in that gutter — invisible at
rest, a 2px bar on hover or focus, collapsing the group when clicked. The outer
turn fold adds no extra hierarchy, and a review-backed Write/Edit stays a single
tool-level row whose only header is the file header above its diff body.

The thinking preference is a boolean `showThinking`. With it on, every visible
Thinking row expands by default in all three display modes and the user may
collapse each row independently; an expanded row shows the full reasoning
markdown, while a collapsed row shows only the Thinking indicator with no summary
or excerpt. With the preference off, no completed reasoning row renders; only a
live whole-run `TextShimmer` `Thinking` indicator remains while reasoning is
actively streaming. The shimmer is a 1.2s linear sweep with a 220ms fade — no
spinner, pulsing dot, or per-character animation — and stays static under
reduced motion. The stored reasoning is retained, so turning the preference back
on restores the rows. Hidden thinking never creates an empty group wrapper.

The leaf default that an earlier decision first introduced was later removed.
Except for the display-mode Thinking defaults above, item payloads never open
themselves: a tool-call, hosted-search or plan row stays a header row until the
user opens it, wherever it sits in the group, and this holds regardless of the
thinking preference. Group defaults are unchanged, and opening a closed ancestor
still exposes the retained item choices without opening all descendants.

Each header toggles only its own level. Parent and child states are independent:
closing a parent preserves descendant choices, reopening restores them, and
sibling groups do not form an accordion. An explicit choice belongs to its own
level alone and never pins an ancestor. Reading protection is transient: while
focus or a selection is inside a level, an automatic close is deferred for that
level and its ancestors, and leaving the content hands control straight back to
the automatic default. Manual choices survive streaming, completion, preference
changes, reparenting from singleton to group, and row remounts while the owning
retained session pane remains alive. Pane eviction, session deletion, or renderer
restart releases this presentation memory; it is not stored in messages or host
settings.

Search/navigation reveals the ancestor path its target needs: the turn process
and, where one exists, the activity group that own the named message. Item-level
targeting is not part of this change, so each row's own details stay behind its
own disclosure.
Replaying the same request does not repeatedly override a later manual close.
Reasoning hidden by the preference stays hidden until the user turns
`showThinking` on. Assistant errors, stopped trailing partial answers,
permission/question/plan/goal decisions, and any other pending action surface
remain outside hidden process content and reachable without expanding it.

Settings → AI → Defaults exposes a `Show thinking` boolean that persists as the
optional `showThinking` `AppSettings` field, and a `Transcript display`
segmented control with the labels `Flat`, `Commands first`, and `Fully folded`
that persists the optional `transcriptDisplayMode` field. Absent and invalid
`transcriptDisplayMode` values resolve to `fully-folded` in both the renderer and
main-process settings normalizers. Absent and non-boolean values for
`showThinking` fall back to the legacy `thinkingDisplayMode` field: an explicit
`compact` hides reasoning while `detailed`, an unknown value, or an absent field
shows it. The legacy `thinkingDisplayMode` and deprecated
`keepCommandsExpanded` fields are retained for persisted-settings compatibility
and are no longer exposed in the UI. `keepCommandsExpanded` is also no longer
read for rendering. These preferences change presentation only; they do not
alter provider thinking levels, runtime/model context, stored reasoning, export,
permissions, execution, or copy payloads, and the thinking preference does not
control turn-process or activity-group folding. Process headers use recorded
timing, direct tool/search counts, and running state; they do not double-count
delegated child work or treat a failed child as a failed assistant turn. The
top-level fold does not repeat issue counts; activity-group headers keep their
own bounded issue summaries.

## Consequences

- One disclosure per turn keeps the final answer and actionable interruptions
  reachable, and makes a long turn collapsible in a single gesture.
- Group folding defaults are unified across display modes: active work stays
  visible, small completed ordinary groups and Task topology groups stay open,
  and larger ordinary groups start closed. Explicit disclosure choices are
  preserved regardless of the thinking preference. Closing the turn's disclosure
  hides the groups under it, and reopening restores their defaults and explicit
  choices.
- With `showThinking` off, no completed reasoning row renders; only the live
  whole-run TextShimmer `Thinking` indicator remains while reasoning streams.
  Stored reasoning is retained and reappears when the preference is turned back
  on.
- `transcriptDisplayMode` keeps the three layouts available and defaults to the
  released `fully-folded` layout. `flat` removes nested groups, `command-first`
  lifts commands to standalone rows, and `fully-folded` keeps commands in their
  groups; all three render exactly one disclosure, and reading the mode while
  rendering repaints the transcript immediately instead of waiting for new
  messages.
- With `showThinking` on, Thinking rows default expanded in `flat`,
  `command-first`, and `fully-folded`.
- The header answers "how did this turn end up" in one short line and carries
  only status, recorded duration and direct tool/search count. A hairline
  underlines the row, the caret trails the metadata, and hover changes ink only.
  Echoing the current command was removed: it pushed the counts off the row and
  duplicated what opening the item already shows.
- Disclosure memory is pane-owned presentation state with stable turn, group,
  and item identities; it is neither a persisted transcript contract nor a
  central workflow-store concern.
- This groups loaded transcript entries only; it does not reconstruct unloaded
  history or join turns across compaction boundaries.

## Validation

For the 2026-09-20 amendment, the request explicitly limits validation to static
checks and compilation. The linked E2E scenarios describe intended behavior for
source and design review; no unit, component, integration, browser, Electron, or
E2E tests are added or run for this amendment. See
E2E-CHAT-turn-process-and-thinking-display for the synchronized scenario text.
For the 2026-09-27 amendment, `apps/desktop/test/turn-process.test.mjs` covers
the default selection, and `pnpm test:e2e:transcript-disclosure` exercises
active-to-completed collapse and user-open retention in real Chromium.
For the 2026-10-16 amendment, `apps/desktop/test/thinking-visibility.test.mjs`
covers the `showThinking`/legacy `thinkingDisplayMode` resolver precedence, and
the i18n catalog tests cover the new `settings.showThinking` copy. The UI,
resolver, and E2E scenarios are validated on the integration candidate; see
E2E-CHAT-turn-process-and-thinking-display for the synchronized scenario text.
For the 2026-10-22 amendment, issue #1806 was reproduced in the React/Electron
transcript harness: after settlement, a small activity group and reasoning rows
were collapsed behind the closed turn process. The amendment keeps groups of up
to four visible items and Task topology groups open, and leaves Thinking rows
expanded by default when `showThinking` is on. The transcript E2E now covers
active-to-settled disclosure behavior, while oversized groups and tool payloads
remain closed by default. See E2E-CHAT-turn-process-and-thinking-display.
For the 2026-10-21 amendment, `apps/desktop/test/turn-process.test.mjs` covers
mode segmentation, including `flat`, `command-first` and `fully-folded`, and
header phase precedence. `apps/desktop/test/transcript-display-modes-ui.test.mjs`
covers the renderer wiring for distinct mode segmentation, Thinking-row defaults
and the whole-run `TextShimmer` used for a collapsed or hidden Thinking
indicator.
`apps/desktop/test/transcript-display-mode-settings.test.mjs` covers the
Settings row label and search indexing, and
`apps/desktop/test/settings-roundtrip.test.mjs` covers normalization, write
validation and the `fully-folded` default. See
E2E-CHAT-turn-process-and-thinking-display for the synchronized scenario text.
For the top-level header amendment on 2026-10-22,
`apps/desktop/test/turn-process-header.test.mjs` renders the top-level header and
covers status, duration, tool count, inline-caret order and the absence of issue
counts in both completed and failed turns;
`apps/desktop/test/turn-process-header-style.test.mjs` covers the hairline,
text-only hover and the inline caret position, while `turn-process.test.mjs` and
`transcript-style.test.mjs` continue to cover phase precedence and the shared
header geometry. See E2E-CHAT-turn-process-and-thinking-display for the
synchronized scenario text.
For the 2026-10-24 automatic-folding amendment,
`apps/desktop/test/activity-group-folding.test.mjs` covers the settled group
defaults, and `pnpm test:e2e:transcript` exercises the automatic turn and group
folding, transient reading protection, manual-choice locality and `Show thinking`
behavior in real Chromium. The same suite measures the activity issue counter's
inline layout at 320/800px and 100%/150% zoom in English and Simplified Chinese.
See E2E-CHAT-turn-process-and-thinking-display.
