# ADR turn-process-and-thinking-display: Turn process and thinking presentation

- Status: Accepted
- Date: 2026-09-17
- Amended: 2026-10-22, 2026-11-04
- Issues: #510, #461, #1806, #2094
- Amends: D071, [ADR 0242](0242-delta-only-streaming-updates.md)

## Context

A model can alternate reasoning, tool calls and progress text many times before
answering one user request. Separate activity groups leave those progress
messages at the same visual level as the answer, while one flat process
container still leaves long tool/search sequences difficult to scan.

## Decision

One unified turn-process presentation applies to every loaded assistant-turn
entry: it projects the entry into one collapsible process disclosure plus its
trailing answer. Thinking, tools, intermediate assistant text and the turn's
`Bash` run rows keep their original order inside that disclosure.

One turn renders exactly one process disclosure. Every row the turn produced
before its answer lives inside it — the activity groups and the `Bash` run rows
alike — so a long turn collapses in one gesture instead of leaving a column of
sibling disclosures above the answer.

- In `fully-folded`, contiguous activity forms ordinary activity groups: one
  contiguous tool/search/thinking/Bash segment between ordinary assistant
  progress paragraphs.
- In `command-first`, ordinary activity groups still render, but every
  `Bash`/run alias is lifted out as a standalone row beside them: adjacent calls
  stay separate and a row's detail stays closed until the user opens it.
- In `flat`, no nested activity groups render at all.

## Consequences

- One disclosure per turn keeps the final answer and actionable interruptions
  reachable, and makes a long turn collapsible in a single gesture.
- Group folding defaults are unified across display modes: active work stays
  visible, small completed ordinary groups and Task topology groups stay open,
  and larger ordinary groups start closed.
- With `showThinking` off, no completed reasoning row renders; only the live
  whole-run TextShimmer `Thinking` indicator remains while reasoning streams.
- `transcriptDisplayMode` keeps the three layouts available and defaults to the
  released `fully-folded` layout.
- With `showThinking` on, Thinking rows default expanded in `flat`,
  `command-first`, and `fully-folded`.
