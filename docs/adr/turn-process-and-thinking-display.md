# ADR turn-process-and-thinking-display: Turn process and thinking presentation

- Status: Accepted
- Date: 2026-09-17
- Amended: 2026-10-16
- Issues: #510, #461
- Amends: D071, [ADR 0242](0242-delta-only-streaming-updates.md)

## Context

A model can alternate reasoning, tool calls and progress text many times before
answering one user request. Separate activity groups leave those progress
messages at the same visual level as the answer, while one flat process
container still leaves long tool/search sequences difficult to scan. Some
readers also need a thinking indicator without rapidly changing reasoning text.

## Decision

One unified turn-process presentation applies to every loaded assistant-turn
entry: it projects the entry into chronological collapsible process segments plus
its trailing answer. Thinking, tools and intermediate assistant text keep their
original order across those segments. A trailing assistant text stays visible
while streaming; if later tool or thinking activity follows, that text moves into
the process without changing the stored message. There is no semantic
final-answer marker in `UiMessage`, so the renderer does not guess intent from
wording. User/system messages and compaction dividers retain their existing turn
boundaries.

The process is segmented rather than one flat container. Non-Bash activity forms
ordinary activity groups: one contiguous tool/search/thinking segment between
progress paragraphs or Bash rows, appearing only when at least two items are
visible under the current thinking preference. A singleton uses its item
disclosure directly; hidden thinking does not create a redundant wrapper.
Existing Task topology remains its segment's container and is not duplicated
inside an ordinary activity group.

Bash and run aliases are excluded from every process disclosure — neither a
turn-level process disclosure nor an ordinary activity group — and render as
standalone rows that stay visible even when every group is collapsed. Adjacent
Bash rows each remain standalone, and a Bash row's detail stays closed until the
user opens it. Other operations between progress paragraphs still form
chronological collapsible activity groups.

Group folding defaults are unified and do not depend on the thinking preference.
The ordinary activity group that owns the active execution segment starts open,
then closes on completion only while untouched. Other completed groups start
closed. An untouched active group containing any recorded failed or denied tool
stays open through later recovery and closes on turn completion if still
untouched. Bash rows remain visible regardless of any group's collapsed state.

The thinking preference is a boolean `showThinking`. When it is false, the live
thinking indicator stays visible, while completed thinking rows and excerpts are
hidden and empty thinking-only containers are omitted; the stored reasoning is
retained, so turning the preference back on restores the completed rows and
excerpts. Hidden thinking never creates an empty group wrapper.

The leaf default that an earlier decision first introduced was later removed.
Item payloads never open themselves: a tool-call, hosted-search or plan row
stays a header row until the user opens it, wherever it sits in the group, and
this holds regardless of the thinking preference. Group defaults are unchanged,
and opening a closed ancestor still exposes the retained item choices without
opening all descendants.

Each header toggles only its own level. Parent and child states are independent:
closing a parent preserves descendant choices, reopening restores them, and
sibling groups do not form an accordion. Manual interaction with an item claims
its containing group as user-owned without toggling it; completion must not close
a container around content the user opened, focused, or selected. Manual choices
survive streaming, completion, preference changes, reparenting from singleton to
group, and row remounts while the owning retained session pane remains alive.
Pane eviction, session deletion, or renderer restart releases this presentation
memory; it is not stored in messages or host settings.

Search/navigation reveals the ancestor path its target needs: the process segment
and the activity group that own the named message. Item-level targeting is not
part of this change, so each row's own details stay behind its own disclosure.
Replaying the same request does not repeatedly override a later manual close.
Reasoning hidden by the preference stays hidden until the user turns
`showThinking` on. Assistant errors, stopped trailing partial answers,
permission/question/plan/goal decisions, and any other pending action surface
remain outside hidden process content and reachable without expanding it.

Settings → AI → Defaults exposes a `Show thinking` boolean that persists as the
optional `showThinking` `AppSettings` field. Absent and non-boolean values fall
back to the legacy `thinkingDisplayMode` field: an explicit `compact` hides
reasoning while `detailed`, an unknown value, or an absent field shows it. The
legacy field is retained for persisted-settings compatibility and is no longer
exposed in the UI. The preference changes presentation only; it does not alter
provider thinking levels, runtime/model context, stored reasoning, export,
permissions, execution, or copy payloads, and it does not control process-segment
or activity-group folding. Process headers use recorded timing, direct tool/search
counts, running state, and issue counts; they do not double-count delegated child
work or treat a failed child as a failed assistant turn.

## Consequences

- Chronological collapsible process segments keep the final answer and actionable
  interruptions reachable, and Bash/run rows stay visible even when every group is
  collapsed.
- Group folding defaults are unified: active work stays visible, untouched
  completed groups fold by default, and explicit disclosure choices are preserved
  regardless of the thinking preference.
- When `showThinking` is false, the live indicator stays visible while completed
  reasoning rows and excerpts are hidden. The stored reasoning is retained and
  reappears when the preference is turned back on.
- Bash and run aliases stay standalone rows outside every process disclosure, so
  shell-heavy turns remain scannable without folding adjacent commands together.
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
