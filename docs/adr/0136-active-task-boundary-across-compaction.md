# ADR 0136: Preserve the active task boundary across context compaction

- Status: Accepted
- Date: 2026-08-31
- Deciders: PI-Desktop core
- Amends: ADR 0064 / D203

## Context

Codex-shaped compaction kept several recent user prompts while dropping the
assistant and tool messages that established whether those prompts were
completed. After a completed task, the next prompt could therefore look like
another bare user message and the model could resume an old task (issue #22).

## Decision

1. Checkpoints carry opaque `details.retainedTailMode`, either
   `active_turn` or `completed_turn`.
2. An active-turn checkpoint is used when the provider must continue after a
   tool result, `toolUse`, or overflow recovery. It retains only the latest
   user message, subject to the existing 20,000-token cap and truncation.
3. A completed-turn checkpoint is used at a terminal turn boundary, before a
   new prompt, and for manual compaction. Its retained tail is empty; the
   summary is authoritative for completed work and the next user prompt is the
   sole new task.
4. The `fresh_window` family remains the ADR 0064 no-summary exception and
   always carries an empty tail.
5. Legacy checkpoints without this field are normalized to their latest user
   message only. The visible transcript, durable checkpoint chain, host
   ownership, and protocol shape do not change.

## Consequences

- Completed user requests cannot be replayed as naked historical context after
  compaction or restart.
- Active tool loops retain the one prompt needed to continue the current task,
  while assistant/tool messages remain represented by the summary.
- Existing checkpoints remain readable without a migration, with a
  conservative latest-user fallback.

## Alternatives

- Retaining multiple recent user messages preserves more literal prompt text,
  but loses the task boundary when completion messages are compacted away.
- Retaining assistant and tool messages would preserve more context but can
  strand incomplete tool calls and violates the Codex-shaped checkpoint form.
