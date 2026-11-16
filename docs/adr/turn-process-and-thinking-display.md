# ADR turn-process-and-thinking-display: Turn process and thinking presentation

- Status: Accepted
- Date: 2026-09-17
- Amended: 2026-10-22, 2026-11-04
- Issues: #510, #461, #1806, #2094
- Amends: D071, [ADR 0242](0242-delta-only-streaming-updates.md)

## Context

A model can alternate reasoning, tool calls, and progress text many times before
answering. Separate activity groups put progress text on the same visual level as
the answer, one flat process container makes long tool sequences hard to scan, and
some readers want a thinking indicator without rapidly changing reasoning text.

## Decision

Every loaded assistant turn is projected into one collapsible process disclosure
plus its trailing answer. Thinking, tools, intermediate text, and the turn's
`Bash` run rows keep their order inside it. Trailing text stays visible while
streaming and moves into the process if later activity follows, without changing
the stored message. `UiMessage` has no final-answer marker, so the renderer never
guesses intent from wording; user/system messages and compaction dividers keep
their turn boundaries.

One turn renders exactly one disclosure holding every row produced before the
answer, so a long turn collapses in one gesture. An untouched process closes when
the turn completes; without final text the header and its error or pending-action
surfaces stay visible.

`AppSettings.transcriptDisplayMode` decides grouping inside the disclosure:
`flat`, `command-first`, or `fully-folded`, with absent or unknown values
resolving to `fully-folded` (the v0.20.0 layout).

- `fully-folded`: contiguous activity forms ordinary groups — one contiguous
  tool/search/thinking/Bash segment between progress paragraphs. A run row stays
  inside its group, and Task topology remains its segment's container.
- `command-first`: groups still render, but every `Bash`/run alias becomes a
  standalone row beside them, closed until opened; a progress message and a
  command both end the current group.
- `flat`: no nested groups; the disclosure lists tools, commands, thinking, and
  progress in transcript order with tool details collapsed.

In the first two modes a group appears only with at least two visible items under
the current thinking preference; a singleton uses its item disclosure. Deprecated
`keepCommandsExpanded` still loads from persisted settings, is hidden from
Settings, is not read for rendering, and new writes store
`transcriptDisplayMode`.

The 2026-11-04 amendment (#2094) replaced the earlier settled defaults (small
groups and Thinking rows stayed open). A settled turn now folds both levels: its
activity groups and every non-streaming Thinking row start closed, so expanding a
finished turn reads as a list of headings. Two opt-outs carry the choice.
`autoCollapseSettledGroups` (`Auto-fold finished groups`) folds settled groups
whatever their size; when off, every settled group stays open — the four-item tier
is retired, because a switch labelled auto-collapse must not still collapse
something. `autoCollapseThinking` (`Auto-fold finished thinking`) folds completed
reasoning; when off, rendered reasoning rows stay open. Each is a sub-row of the
setting that gates it (`Show thinking`, and a non-flat `Transcript display`), and
hiding a sub-row never writes a value, so the stored choice survives toggling the
parent. The group no longer inherits open state from contained reasoning: closing
hides expanded reasoning, reopening restores each row's own answer. Live work never
folds — a running turn, or a group owning a running tool or delegation, stays open.
A folded group is one line whose header states its composition: contained actions
joined with the locale's list wording, capped at three plus "and more", then the
call count as a separate token that ellipsizes last (`搜索并读取文件 · 12 次操作`).
Reasoning is named but is not an operation, and a reasoning-only group counts steps.
The group header renders no issue counter, because the failed row reports itself.

The disclosure header states the outcome with only bounded metadata: status,
recorded duration, and direct tool/search count. It never echoes the item being
worked on, since a command or query can be arbitrarily long. It reads `failed`,
`stopped`, `running`, or finished, in that precedence: a recorded failure outranks
a stop, because the turn produced no answer. A stop comes from an aborted message,
the only signal the runtime records; aborted activity rows record a stop while a
step is in flight, and delegated child rows never decide the parent's outcome.
While running, compaction and recovery name themselves, a live reasoning step reads
`Thinking`, and momentary stages read as running. Missing timing drops the duration
instead of showing zero. The header is a full-width row on a hairline, with status,
duration, tool count, and caret as one left-aligned run; hover changes ink only.

The disclosure and group headers share one left edge. A nested group keeps the
v0.20.1 hierarchy: children indent 12px, with the group's collapse rail in that
gutter — invisible at rest, a 2px bar on hover or focus. The outer fold adds no
hierarchy, and a review-backed Write/Edit stays a single tool-level row under its
file header.

Thinking is the boolean `showThinking`. When on, visible Thinking rows expand by
default in all modes and can be collapsed per row: expanded shows full reasoning
markdown, collapsed shows only the indicator with no summary. When off, no
completed reasoning row renders; a live whole-run `TextShimmer` `Thinking`
indicator remains while reasoning streams — a 1.2s linear sweep with a 220ms fade,
no spinner or per-character animation, static under reduced motion. Stored
reasoning is retained, so re-enabling restores the rows, and hidden thinking never
creates an empty group wrapper.

Apart from those Thinking defaults, item payloads never open themselves: a
tool-call, hosted-search, or plan row stays a header row until the user opens it.
Each header toggles only its own level: closing a parent preserves descendant
choices, siblings do not form an accordion, and an explicit choice never pins an
ancestor. Reading protection is transient — while focus or a selection is inside a
level, automatic close is deferred for it and its ancestors. Manual choices survive
streaming, completion, preference changes, reparenting, and row remounts while the
retained pane lives; pane eviction, session deletion, or restart releases this
pane-owned presentation state, which is never stored in messages or host settings.

Search/navigation reveals the ancestor path its target needs — the turn process
and any owning group. Replaying a request never overrides a later manual close,
reasoning hidden by the preference stays hidden until `showThinking` is on, and
errors, stopped partial answers, and pending permission/question/plan/goal
decisions stay outside hidden process content and reachable without expanding it.

Settings → AI → Defaults exposes `Show thinking` (optional `showThinking`) and
`Transcript display` (`Flat`, `Commands first`, `Fully folded`, optional
`transcriptDisplayMode`); absent or invalid mode values resolve to `fully-folded`
in both the renderer and the main-process normalizers. Absent or non-boolean
`showThinking` falls back to legacy `thinkingDisplayMode`: `compact` hides
reasoning, while `detailed`, unknown, or absent shows it. Legacy fields stay only
for persisted-settings compatibility. These preferences change presentation only —
never provider thinking levels, context, stored reasoning, export, permissions,
execution, or copy payloads — and the thinking preference does not control
folding. Headers use recorded timing, direct counts, and running state, never
double-count delegate work, and never treat a failed child as a failed turn.

## Consequences

- One disclosure per turn keeps the answer and actionable interruptions reachable
  and makes a long turn collapsible in one gesture.
- Fold defaults are uniform across modes, explicit choices survive the thinking
  preference, and reopening a turn restores group defaults and explicit choices.
- With `showThinking` off only the live whole-run shimmer remains; stored reasoning
  reappears when it is re-enabled.
- `transcriptDisplayMode` keeps three layouts with the released `fully-folded`
  default, and reading the mode while rendering repaints immediately.
- The header answers "how did this turn end up" in one line; echoing the current
  command was removed because it pushed the counts off the row.
- Disclosure memory is pane-owned presentation state with stable identities, not a
  persisted transcript contract, and grouping covers loaded entries only — it never
  reconstructs unloaded history or joins turns across compaction boundaries.
