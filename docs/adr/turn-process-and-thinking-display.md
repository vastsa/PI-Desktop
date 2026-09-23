# ADR turn-process-and-thinking-display: Turn process and thinking presentation

- Status: Accepted
- Date: 2026-09-17
- Amended: 2026-09-21
- Issues: #510, #461, #639
- Amends: D071, [ADR 0242](0242-delta-only-streaming-updates.md)

## Context

A model can alternate reasoning, tool calls and progress text many times before
answering one user request. Separate activity groups leave those progress
messages at the same visual level as the answer, while one flat process
container still leaves long tool/search sequences difficult to scan. Some
readers also need a thinking indicator without rapidly changing reasoning text.

## Decision

Both display modes project each loaded assistant-turn entry into one
turn-process disclosure plus its trailing answer. Thinking, tools and
intermediate assistant text keep their original order inside the process. A
trailing assistant text stays visible while streaming; if later tool or
thinking activity follows, that text moves into the process without changing
the stored message. There is no semantic final-answer marker in `UiMessage`,
so the renderer does not guess intent from wording. User/system messages and
compaction dividers retain their existing turn boundaries.

Accepted human supplements carry the existing durable `steering: true` marker.
When the loaded task context exists, these user messages are ordered parts of
the same process rather than new task boundaries. Earlier work stays active
while the supplement is delivered; completion folds the work before and after
it together with the supplemental bubble. The initial user timestamp continues
to anchor elapsed time. Supplemental user text is never assistant answer text,
model usage or a second task summary. Search can reveal the contained bubble.
Ordinary queued prompts, including the queue's **Send now** action, and legacy
messages without the marker still start new tasks. Send now promotes a queued
prompt and gracefully stops the active turn; it does not use active-turn
steering. No durable parent-task link is stored for the promoted prompt, so the
renderer must not infer a continuation from priority, adjacency, aborted
status, timestamps, or message content. Active-turn supplemental input uses the
existing Alt+Enter steering path.

The process has three independent disclosure levels: the whole turn process, an
ordinary activity group, and one item's details. An ordinary activity group
contains one contiguous tool/search/thinking segment between progress
paragraphs and appears only when the mode has at least two visible items. A
singleton uses its item disclosure directly; hidden compact-mode thinking does
not create a redundant wrapper. Existing Task topology remains its segment's
container and is not duplicated inside an ordinary activity group.

Both modes start an active whole-process disclosure expanded and collapse it on
completion. The active-to-completed transition uses a new process identity so
active nested interaction cannot keep completed history expanded. The header
shows an icon-only failure/issue marker whenever the process has issues,
including while folded. Reopening after completion
survives subsequent updates; search navigation opens the containing process,
then the activity group that owns the named message. Item-level targeting is
not part of this change.

Detailed mode retains reasoning in the process. The ordinary group that owns
the active execution segment starts open, then closes on completion only while
untouched. Other completed ordinary groups start closed. Leaf auto-open applies
only to the literal final item of the last activity group when it is an
eligible tool-call or hosted-search row; failed and denied items remain guarded
closed. The renderer does not scan backward past a final thinking item. Compact
keeps its indicator-only thinking policy, starts ordinary groups closed, and
keeps every tool/search payload closed.

Each nested header toggles only its own level. Parent and child states are
independent: closing a parent preserves descendant choices, reopening restores
them, and sibling groups do not form an accordion. Manual interaction with an
item claims the containing group without toggling it. Nested choices survive
streaming, mode changes, reparenting from singleton to group, and row remounts
while the owning retained session pane remains alive. Pane eviction, session
deletion, or renderer restart releases this presentation memory; it is not
stored in messages or host settings.

Settings → AI → Defaults retains `thinkingDisplayMode`, the optional
`detailed | compact` `AppSettings` field. Absent or unrecognized values resolve
to detailed. The field changes presentation only; it does not alter provider
thinking levels, runtime/model context, stored reasoning, export, permissions,
execution, or copy payloads. Process headers use recorded timing, tool counts,
running state, and issue counts; they do not double-count delegated child work
or treat a failed child as a failed assistant turn. Process durations start at
the initiating user timestamp when loaded, fall back to the first valid part
timestamp, and end at recorded message/tool completion. A live UI clock adds no
persisted fields. User bubbles and completed assistant turns display a localized
semantic time from existing timestamps in the hover action chrome.

## Consequences

- Both modes expose one whole-process disclosure while keeping the final answer
  and actionable interruptions reachable outside it. Completed processes start
  collapsed even in Detailed.
- Detailed mode keeps nested progress narration recoverable, folds untouched
  completed activity groups, and preserves the literal-final-item leaf default.
- Compact mode remains the low-detail option: the process is folded after
  completion, payloads stay closed, and reasoning content is suppressed.
- Disclosure memory is pane-owned presentation state with stable turn, group,
  and item identities; whole-process completion uses a distinct identity so
  claimed active opens do not persist. It is neither a persisted transcript
  contract nor a central workflow-store concern.
- This groups loaded transcript entries only; it does not reconstruct unloaded
  history or join turns across compaction boundaries.

## Validation

For the 2026-09-20 amendment, the request explicitly limits validation to static
checks and compilation. The linked E2E scenarios describe intended behavior for
source and design review; no unit, component, integration, browser, Electron, or
E2E tests are added or run for this amendment. See
E2E-CHAT-turn-process-and-thinking-display for the synchronized scenario text.
