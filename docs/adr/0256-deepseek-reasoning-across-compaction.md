# ADR 0256: Preserve DeepSeek reasoning across context compaction

- Status: Accepted
- Date: 2026-09-15
- Amends: D389 / ADR 0136 / ADR 0064
- Fixes: #296
- Amended by: D677 (#1945) — decision 3 now normalizes every row to the
  newest row's field and fills only rows with no reasoning

## Context

DeepSeek thinking mode requires every replayed Completions assistant message to
carry a reasoning field (`reasoning_content`, or `reasoning_text` / `reasoning` on
some relays). Official endpoints accept `""` for a turn that produced no thinking
(D389 / #223), while OpenCode and third-party relays reject empty echoes with HTTP
400, and Codex-shaped compaction (ADR 0064 / ADR 0136) drops the assistant turns
that carried thinking.

## Decision

1. History rebuild stamps `thinkingSignature: "reasoning_content"` only for
   DeepSeek-compatible OpenAI Completions rows; other APIs keep unsigned thinking so
   pi-ai preserves their plain-text fallback.
2. Checkpoints for models with `requiresReasoningContentOnAssistantMessages` store
   the last few thinking turns in opaque `details.retainedReasoning`, and session
   context injects them between the compaction summary and the user tail only for
   the live DeepSeek-compatible binding.
3. The pi-ai patch backfills the reasoning field already present on the history,
   keeping empty-string fill for official DeepSeek URLs while non-official rows set
   `requiresNonEmptyReasoningReplay` and receive the placeholder
   `[reasoning not retained for this turn]`.
4. ADR 0136 retained-tail rules are unchanged: user-only tails, no tool-call replay.
5. Amendment (D677, #1945): the field is taken from the newest assistant row with
   real reasoning and every row is normalized to it, so real reasoning under another
   name moves there and the placeholder fills only rows with none.

## Consequences

- Post-compaction DeepSeek requests through OpenCode and aggregators keep real or
  placeholder reasoning instead of failing on an empty echo.
- Official DeepSeek empty backfill keeps working, and checkpoint `details` grow only
  by a bounded reasoning excerpt.
- The visible transcript and host schema do not change.

## Alternatives

- Degrade to non-thinking mode after the 400 — rejected: it loses reasoning and
  hides the compaction gap.
- Put full assistant and tool messages back in `retainedTail` — rejected: it
  reintroduces stranded tool calls.
