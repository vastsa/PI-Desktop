# ADR 0337: Keep the request prefix stable across delegation settlements

- Status: Accepted
- Date: 2026-10-25
- Related: ADR 0279 (resumable subagent delegations), ADR 0089 (delegation tools)
- Amends: ADR 0279 §9

## Context

ADR 0279 §9 put the resumable-chain list into the parent's system prompt and
recomposed that prompt whenever a delegation settled, so the parent would see what
it can continue without a tool call. Providers cache a conversation by the exact
byte prefix of the request, and PI-Desktop appends changed system sections rather
than rewriting the first one (`syncSystemSections`). Only a narrow DeepSeek route
supports `supportsMidConvoSystemMessages`; every other model replays all system
messages into the first block through `collapseSystemMessages`, so each settlement
could invalidate the whole cached prefix rather than its tail.

## Decision

1. The system prompt never carries delegation state. `composeSystemPrompt` no
   longer composes a resumable block and the runtime no longer recomposes the
   prompt on settlement; instructions change only for reasons the user controls,
   such as mode, project instructions, memory, skills, or a custom prompt.
2. `TaskList` is the discovery path. Its result carries the resumable chains —
   agent name, `delegationId`, objective, and up to `MAX_RESUMABLE_LISTED_FILES`
   files read — as text through `formatResumableList` and as a structured
   `details.resumable` array, and its description names `Task(resume: ...)` as the
   reason to call it.
3. Tool errors stay authoritative. Unknown, mismatched, over-budget, and
   history-less resume ids still return a tool error naming the reusable ids inline
   (`DelegationChainRegistry.unknownResumeError` and `noHistoryResumeError`), so a
   failed resume never depends on a prior `TaskList`.
4. The registry keeps its own gate: `resumableList` still excludes running,
   non-resumable, and over-budget chains, so a listing never advertises an id the
   resume path would reject.

The `resumablePromptStale` deferral, `refreshResumablePrompt`, and the
`applyPendingResumablePrompt` recovery calls are removed with their reason, since
no prompt-level resumable state remains.

## Consequences

- Delegation settlements are invisible to the request prefix, so a long session
  keeps one cache lineage until something the user changed does.
- The parent pays for a `TaskList` call only when it needs ids, and a blind resume
  still gets them back in its error; the listing grows with chain count
  (`MAX_RESUMABLE_CHAINS_PER_AGENT`), not with the conversation.
- This fixes one source of prefix churn only: `TOOL_ACTIVATION_SECTION` and the
  context-budget reminder still append system messages mid-turn, and ADR 0279 §9
  is superseded by decision 2 while its other decisions stand.

## Alternatives

- Refresh the list at turn start: still rewrites the collapsed first block after
  each delegation.
- Move the list into the last user message: rewrites history the transcript owns.
