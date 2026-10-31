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

That recomposition breaks provider prompt caching. Anthropic, OpenAI, and the
gateways in front of them cache a conversation by the exact byte prefix of the
request: instructions, then tools, then messages. PI-Desktop does not rewrite
the leading system message in place — `syncSystemSections` appends a new
system message carrying only the changed sections
(`packages/agent-runtime/src/system-transcript.ts`). Which one of two request
shapes goes out depends on the transport:

- A model with `supportsMidConvoSystemMessages` keeps the appended system
  message in place, so only the tail is new.
- Every other model goes through `collapseSystemMessages`
  (`@earendil-works/pi-ai`, `utils/transcript.js`), which replays all system
  messages into **the first** one. The changed section therefore changes the
  first system block of the request.

The verified catalog sets `supportsMidConvoSystemMessages` only for a narrow
DeepSeek route (`packages/agent-runtime/src/fixed-tool-declarations.ts`,
`transcript-compat.ts`); for everything else the collapsed shape applies. So
each settlement — up to `MAX_SUBAGENT_CONCURRENCY` per turn, plus resumptions —
could invalidate the whole cached prefix, not just its tail. The cost scales
with session length, which is exactly the case delegation exists to keep cheap.

The organization of the system prompt also matters more than one prompt block:
a section that changes on its own schedule turns a stable conversation into a
sequence of unrelated caches.

## Decision

1. **The system prompt never carries delegation state.** `composeSystemPrompt`
   no longer composes a resumable block, and the runtime no longer recomposes
   the prompt on settlement. Instructions change only for reasons the user
   controls: mode, project instructions, memory, skills, custom prompt.
2. **`TaskList` is the discovery path.** Its result now carries the resumable
   chains — agent name, `delegationId`, objective, and up to
   `MAX_RESUMABLE_LISTED_FILES` files read — as both text (the existing
   `formatResumableList` rendering) and a structured `details.resumable` array.
   Its description names `Task(resume: ...)` as the reason to call it.
3. **Tool errors stay authoritative.** Unknown, mismatched, over-budget, and
   history-less resume ids still return a tool error that names the reusable
   ids inline (`DelegationChainRegistry.unknownResumeError` /
   `noHistoryResumeError`), so a failed resume never depends on the parent
   having called `TaskList` first.
4. **The registry keeps its own gate.** `resumableList` still excludes running,
   non-resumable, and over-budget chains, so a listing never advertises an id
   the resume path would reject.

The `resumablePromptStale` deferral, the `refreshResumablePrompt` hook, and the
two `applyPendingResumablePrompt` calls in the silent-turn and progress-turn
recovery paths are removed with their reason: there is no prompt-level
resumable state left to defer.

## Consequences

- Delegation settlements are invisible to the request prefix. A long session
  that spawns many delegates keeps one cache lineage until something the user
  actually changed (instructions, mode, skills, conversation content) does.
- The parent must call `TaskList` to learn ids proactively. That is a tool call
  the model already owns and only pays for when it needs the ids; a resume it
  attempts blind still gets the ids back in the error.
- `TaskList` grows with the reusable chain count (bounded by
  `MAX_RESUMABLE_CHAINS_PER_AGENT`), not with the conversation.
- This ADR fixes one source of prefix churn, not all of them.
  `TOOL_ACTIVATION_SECTION` (on-demand tool activation) and the context-budget
  reminder still append system messages mid-turn for their own documented
  reasons; changing those is separate work with its own trade-offs.
- ADR 0279 §9 is superseded by decision 2 here; its other decisions stand.

## Alternatives Considered

- **Refresh the list only at turn start.** Cheap and would cut the churn to one
  rewrite per turn, but it still rewrites the collapsed first system block
  whenever the settled set grew, so a turn after every delegation misses the
  whole prefix. It also keeps a per-turn-variable section in instructions whose
  job is to be stable.
- **Move the list into the last user message.** Keeps the head stable and needs
  no new tool surface, but it rewrites conversation history the transcript owns
  and would make the persisted rows disagree with the request.
- **Keep the list in the prompt and mark it cache-friendly.** Providers cache
  bytes, not sections; no marker changes the invalidation.

## Verification

- `packages/agent-runtime/src/runtime.test.ts`: a settled delegation leaves both
  `composedSystemPrompt` and the live system prompt byte-identical, and the
  resumable entry appears in `TaskList`'s text and `details.resumable`.
- `packages/agent-runtime/src/delegation-chain.test.ts`: listing gates
  (running, non-resumable, over-budget, ordering) and the block rendering.
- `apps/desktop` transcript and delegation suites are unaffected; the change is
  confined to prompt composition and the `TaskList` result shape.
