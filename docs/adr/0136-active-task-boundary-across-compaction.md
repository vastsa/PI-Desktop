# ADR 0136: Preserve the active task boundary across context compaction

- Status: Accepted
- Date: 2026-08-31
- Amends: ADR 0064 / D203

## Context

Codex-shaped compaction kept several recent user prompts while dropping the
assistant and tool messages that established whether they were completed, so after
a finished task the next prompt could look like another bare user message and the
model resumed the old task (issue #22).

## Decision

Checkpoints carry an opaque `details.retainedTailMode` of `active_turn` or
`completed_turn`. An active-turn checkpoint, used when the provider must continue
after a tool result, `toolUse`, or overflow recovery, retains only the latest user
message under the existing 20,000-token cap; a completed-turn checkpoint, used at
a terminal boundary, before a new prompt, and for manual compaction, retains an
empty tail so the summary is authoritative. The `fresh_window` family stays the
ADR 0064 no-summary exception, and legacy checkpoints without the field normalize
to their latest user message, leaving the transcript and checkpoint chain
unchanged.

## Consequences

- Completed requests cannot be replayed as naked historical context after
  compaction or restart.
- Active tool loops keep the one prompt needed to continue, with assistant and
  tool messages represented by the summary.
- Existing checkpoints stay readable without a migration.

## Alternatives

- Retain multiple recent user messages: more literal prompt text, but the task
  boundary is lost once completion messages are compacted away.
- Retain assistant and tool messages: more context, but it can strand incomplete
  tool calls and breaks the Codex-shaped checkpoint form.
