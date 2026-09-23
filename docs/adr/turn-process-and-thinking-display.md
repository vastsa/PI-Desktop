# ADR turn-process-and-thinking-display: Turn process and thinking presentation

- Status: Accepted
- Date: 2026-09-17
- Amended: 2026-09-20, 2026-09-23
- Issues: #510, #461
- Amends: D071, [ADR 0242](0242-delta-only-streaming-updates.md)

## Context

A model can alternate reasoning, tool calls and progress text many times before
answering one user request. Separate activity groups leave those progress
messages at the same visual level as the answer, while one flat process
container still leaves long tool/search sequences difficult to scan. Some
readers also need a thinking indicator without rapidly changing reasoning text.
Progress text also reads as the answer while the turn is still working, and one
aggregate count hides which kind of work a turn did.

## Decision

Both display modes project each loaded assistant-turn entry into one turn-process
disclosure plus its trailing answer. Thinking, tools and intermediate assistant
text keep their original order inside the process. A trailing assistant text
stays visible while streaming; if later tool or thinking activity follows, that
text moves into the process without changing the stored message. There is no
semantic final-answer marker in `UiMessage`, so the renderer does not guess
intent from wording. User/system messages and compaction dividers retain their
existing turn boundaries.

The process has three independent disclosure levels: the whole turn process, an
ordinary activity group, and one item's details. An ordinary activity group
contains one contiguous tool/search/thinking segment between progress paragraphs
and appears only when the mode has at least two visible items. A singleton uses
its item disclosure directly; hidden compact-mode thinking does not create a
redundant wrapper. Existing Task topology remains its segment's container and is
not duplicated inside an ordinary activity group.

Detailed mode starts an active whole-process disclosure open, keeps a running
turn's process open, and folds the whole process on completion while untouched. A
turn counts as complete only when it left flight and its trailing answer is a
recorded success: the runtime also reports `complete` for a message that stopped
on a tool call, so message status alone would fold a turn that is still working.
A manual or revealed open survives the fold. The ordinary group that owns the
active execution segment starts open, then closes on completion only while
untouched. Other completed ordinary groups start closed. Compact mode starts
process and ordinary-group disclosures closed, but an untouched active process
containing any recorded failed or denied tool stays open through later recovery
and closes on turn completion if still untouched. Compact mode keeps every
tool/search payload closed and renders no reasoning text or excerpt; it shows
only the active thinking indicator and omits empty completed thinking-only
containers.

Detailed mode preserves the leaf default only for the literal final item of the
last activity group. If that item is an eligible tool-call or hosted-search row,
its payload starts open; failed and denied items remain guarded closed. The
renderer does not scan backward past a final thinking item to open an earlier
tool. Opening a closed ancestor exposes the retained leaf state without opening
all descendants.

While a turn is running and the process already holds an earlier tool call or
hosted-search round, the trailing assistant text presents as interim narration:
it renders at the process indentation, in the secondary tone, and outside the
collapsible body, so folding never hides text that is still streaming. The
presentation follows from turn state alone and never inspects wording, and it is
removed when the message stops streaming. There is still no semantic
final-answer marker in `UiMessage`.

Each header toggles only its own level. Parent and child states are independent:
closing a parent preserves descendant choices, reopening restores them, and
sibling groups do not form an accordion. Manual interaction with an item claims
the containing group and process as user-owned without toggling either ancestor;
completion must not close a container around content the user opened, focused,
or selected. A close nobody asked for — the completion fold — hands its header to
the scroll owner instead: that owner holds the header for a reader who left the
tail, and exempts a reader still following the tail, where holding the collapsed
header would drag the answer out of view. Manual choices survive streaming,
completion, mode changes,
reparenting from singleton to group, and row remounts while the owning retained
session pane remains alive. Pane eviction, session deletion, or renderer restart
releases this presentation memory; it is not stored in messages or host settings.

Search/navigation reveals the ancestor path its target needs: the process, then
the activity group that owns the named message. Item-level targeting is not part
of this change, so each row's own details stay behind its own disclosure.
Replaying the same request does not repeatedly override a later manual close.
Compact-mode reasoning remains hidden until the user chooses Detailed. Assistant
errors, stopped trailing partial answers, permission/question/plan/goal
decisions, and any other pending action surface remain outside hidden process
content and reachable without expanding it.

Settings → AI → Defaults retains `thinkingDisplayMode`, the optional
`detailed | compact` `AppSettings` field. Absent or unrecognized values resolve
to detailed. The field changes presentation only; it does not alter provider
thinking levels, runtime/model context, stored reasoning, export, permissions,
execution, or copy payloads. Process headers use recorded timing, running state
and issue counts, and report visible work as non-overlapping categories: tool
calls, command executions (`getToolAction()` classifies those as `run`),
hosted-search rounds, and thinking steps. The whole-turn header and an ordinary
group header show the same breakdown with empty categories omitted; a delegated
child stays inside its parent `Task` call, so no child work is counted twice and
a failed child is not a failed assistant turn.

## Consequences

- Both modes expose one whole-process disclosure while keeping the final answer
  and actionable interruptions reachable outside it.
- Detailed mode keeps progress narration visible by default, folds an untouched
  completed whole process, folds untouched completed activity groups, and
  preserves the literal-final-item leaf default.
- Compact mode remains the low-detail option: the process is folded, payloads
  stay closed, and reasoning content is suppressed.
- Disclosure memory is pane-owned presentation state with stable turn, group,
  and item identities; it is neither a persisted transcript contract nor a
  central workflow-store concern.
- This groups loaded transcript entries only; it does not reconstruct unloaded
  history or join turns across compaction boundaries.

## Validation

For the 2026-09-20 amendment, the request explicitly limits validation to static
checks and compilation. The linked E2E scenarios describe intended behavior for
source and design review; no unit, component, integration, browser, Electron, or
E2E tests are added or run for that amendment.

For the 2026-09-23 amendment, the behavior is implemented and covered: unit tests
for the count model and the completion predicate
(`apps/desktop/test/activity-summary.test.mjs`,
`apps/desktop/test/turn-process.test.mjs`), the narration tone
(`apps/desktop/test/transcript-style.test.mjs`), and both transcript E2E
scenarios (`pnpm test:e2e:transcript`, `pnpm test:e2e:transcript-disclosure`),
which also measure the fold against a real scroller. See
E2E-CHAT-turn-process-and-thinking-display for the synchronized scenario text.
