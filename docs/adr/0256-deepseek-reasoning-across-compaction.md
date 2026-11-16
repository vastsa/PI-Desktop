# ADR 0256: Preserve DeepSeek reasoning across context compaction

- Status: Accepted
- Date: 2026-09-15
- Deciders: PI-Desktop core
- Amends: D389 / ADR 0136 / ADR 0064
- Fixes: #296
- Amended by: D677 (#1945) — decision 3 now normalizes every row to the
  newest row's field and fills only rows with no reasoning

## Context

DeepSeek thinking mode requires every replayed Completions assistant message to
carry a reasoning field (`reasoning_content`, or `reasoning_text` / `reasoning`
on some relays). Official `deepseek.com` endpoints accept `""` for turns that
produced no thinking (D389 / #223).

## Decision

1. History rebuild stamps `thinkingSignature: "reasoning_content"` only for
   DeepSeek-compatible OpenAI Completions rows.
2. Checkpoints for models with `requiresReasoningContentOnAssistantMessages`
   store the last few thinking turns in opaque `details.retainedReasoning` (text
   + thinking only, no tool calls).
3. The pi-ai patch backfills the reasoning field already present on the history
   (`reasoning_content` | `reasoning_text` | `reasoning`).
4. ADR 0136 retained-tail rules are unchanged: user-only tails, no tool-call
   replay.
5. Amendment (D677, #1945): the field is taken from the newest assistant row
   that has real reasoning, not from fixed list order.

## Consequences

- Post-compaction DeepSeek requests on OpenCode / aggregators keep real or
  placeholder reasoning and no longer 400 on empty echoes.
- Official DeepSeek and #223 empty-backfill behaviour remain available.
- Checkpoint `details` grow by a bounded reasoning excerpt; the visible
  transcript and host schema do not change.
- Unit tests cover convertMessages + compaction retained-reasoning wire shape.

## Alternatives

- Degrade to non-thinking mode after the 400: avoids the echo requirement but
  loses reasoning for that turn and hides the compaction gap.
- Put full assistant/tool messages back in `retainedTail`: preserves reasoning
  but reintroduces stranded tool calls and weakens the task boundary (rejected
  by ADR 0136).
