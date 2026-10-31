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
carry a reasoning field (`reasoning_content`, or `reasoning_text` /
`reasoning` on some relays). Official `deepseek.com` endpoints accept `""` for
turns that produced no thinking (D389 / #223). OpenCode and third-party relays
for DeepSeek V4.1 Flash reject empty echoes with HTTP 400 ("reasoning_text must
be passed back").

Codex-shaped compaction (ADR 0064 / ADR 0136) drops assistant turns from the
retained tail so tool-call pairs cannot strand and completed user prompts do
not look like new tasks. That also drops thinking. Reloading a session rebuilds
assistant content from `UiMessage.thinking` without a Completions
`thinkingSignature`, so convertMessages silently omits the reasoning field and
the #223 empty backfill fills `""` — which strict relays reject.

## Decision

1. History rebuild stamps `thinkingSignature: "reasoning_content"` only for
   DeepSeek-compatible OpenAI Completions rows. Other APIs keep unsigned
   thinking so pi-ai preserves their existing plain-text fallback; their
   provider-native signatures are not interchangeable with Completions fields.
2. Checkpoints for models with `requiresReasoningContentOnAssistantMessages`
   store the last few thinking turns in opaque `details.retainedReasoning`
   (text + thinking only, no tool calls). Session context injects those turns
   between the compaction summary and the user tail only for the live
   DeepSeek-compatible Completions binding; other providers do not receive
   synthetic DeepSeek reasoning.
3. The pi-ai patch backfills the reasoning field already present on the history
   (`reasoning_content` | `reasoning_text` | `reasoning`). Official DeepSeek
   URLs keep empty-string fill. Non-official DeepSeek-family Completions rows
   set `requiresNonEmptyReasoningReplay` and receive the documented placeholder
   `[reasoning not retained for this turn]` instead of `""`.
4. ADR 0136 retained-tail rules are unchanged: user-only tails, no tool-call
   replay.
5. Amendment (D677, #1945): the field is taken from the newest assistant row
   that has real reasoning, not from fixed list order. Every assistant row is
   normalized to that one field: real reasoning under another field name is
   moved there, and the placeholder fills only rows with no reasoning at all.
   A rebuilt row is stamped `reasoning_content` while a live relay row keeps
   `reasoning_text`; the old pass picked `reasoning_content` and filled the
   placeholder over the live row's real reasoning, in the field the model
   reads, and the model echoed it. A leading echo of the placeholder in stored
   thinking is neither displayed nor replayed.

## Consequences

- Post-compaction DeepSeek requests on OpenCode / aggregators keep real or
  placeholder reasoning and no longer 400 on empty echoes.
- Official DeepSeek and #223 empty-backfill behaviour remain available.
- Checkpoint `details` grow by a bounded reasoning excerpt; the visible
  transcript and host schema do not change.
- Unit tests cover convertMessages + compaction retained-reasoning wire shape.
  Live OpenCode / aggregator verification remains deferred (see E2E-005E).

## Alternatives

- Degrade to non-thinking mode after the 400: avoids the echo requirement but
  loses reasoning for that turn and hides the compaction gap.
- Put full assistant/tool messages back in `retainedTail`: preserves reasoning
  but reintroduces stranded tool calls and weakens the task boundary (rejected
  by ADR 0136).
