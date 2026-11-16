# ADR 0337: Keep the request prefix stable across delegation settlements

- Status: Accepted
- Date: 2026-10-25
- Deciders: PI-Desktop maintainers
- Related: ADR 0279 (resumable subagent delegations), ADR 0089 (delegation
  tools), `docs/spec/03-runtime/02-agent-runtime.md`
- Amends: ADR 0279 §9

## Context

ADR 0279 §9 put the resumable-chain list into the parent's **system prompt**,
and recomposed that prompt every time a delegation settled. The intent was that
the parent sees what it can continue without calling a tool.

- A model with `supportsMidConvoSystemMessages` keeps the appended system
  message in place, so only the tail is new.
- Every other model goes through `collapseSystemMessages`
  (`@earendil-works/pi-ai`, `utils/transcript.js`), which replays all system
  messages into **the first** one.

## Decision

1. **The system prompt never carries delegation state.** `composeSystemPrompt`
   no longer composes a resumable block, and the runtime no longer recomposes
   the prompt on settlement.
2. **`TaskList` is the discovery path.** Its result now carries the resumable
   chains — agent name, `delegationId`, objective, and up to
   `MAX_RESUMABLE_LISTED_FILES` files read — as both text (the existing
   `formatResumableList` rendering) and a structured `details.resumable` array.
3. **Tool errors stay authoritative.** Unknown, mismatched, over-budget, and
   history-less resume ids still return a tool error that names the reusable ids
   inline (`DelegationChainRegistry.unknownResumeError` /
   `noHistoryResumeError`), so a failed resume never depends on the parent
   having called `TaskList` first.
4. **The registry keeps its own gate.** `resumableList` still excludes running,
   non-resumable, and over-budget chains, so a listing never advertises an id
   the resume path would reject.

The `resumablePromptStale` deferral, the `refreshResumablePrompt` hook, and the
two `applyPendingResumablePrompt` calls in the silent-turn and progress-turn
recovery paths are removed with their reason: there is no prompt-level resumable
state left to defer.

## Consequences

- Delegation settlements are invisible to the request prefix.
- The parent must call `TaskList` to learn ids proactively.
- `TaskList` grows with the reusable chain count (bounded by
  `MAX_RESUMABLE_CHAINS_PER_AGENT`), not with the conversation.
- This ADR fixes one source of prefix churn, not all of them.
- ADR 0279 §9 is superseded by decision 2 here; its other decisions stand.

## Alternatives Considered

- **Refresh the list only at turn start.** Cheap and would cut the churn to one
  rewrite per turn, but it still rewrites the collapsed first system block
  whenever the settled set grew, so a turn after every delegation misses the
  whole prefix.
- **Move the list into the last user message.** Keeps the head stable and needs
  no new tool surface, but it rewrites conversation history the transcript owns
  and would make the persisted rows disagree with the request.
- **Keep the list in the prompt and mark it cache-friendly.** Providers cache
  bytes, not sections; no marker changes the invalidation.
