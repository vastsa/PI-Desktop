# ADR 0279: Resumable subagent delegations

- Status: Accepted for implementation
- Date: 2026-09-17
- Related: [ADR 0062](0062-bounded-subagents-behind-a-task-tool.md) ·
  [ADR 0089](0089-proactive-background-subagent-delegation.md) ·
  [ADR 0119](0119-event-driven-subagent-timeouts.md) ·
  [ADR 0165](0165-withdraw-a2a-peer-stack.md) ·
  [03-runtime/02-agent-runtime.md](../spec/03-runtime/02-agent-runtime.md) §5f
- Amends: ADR 0062 (the `Task` tool contract) and ADR 0089 (the delegation
  lifecycle). Both are preserved; this adds one opt-in parameter and one piece
  of bookkeeping.
- Tracking: #513

## Context

ADR 0062 and ADR 0089 spawn one single-use `SubagentRun` per `Task` call,
starting from `messages: []`. A delegate's rows persist with `parentToolCallId`
and `agentName`, but nothing reads them back into a delegate and the session
runtime skips them when rebuilding model context, so every `Task` call is a cold
start even when the parent delegates the same subagent for the same files twice.

## Decision

`Task` gains an opt-in `resume` parameter; when present the new delegation is
seeded with the prior delegation's reconstructed context instead of starting
empty.

### 1. `Task` gains `resume?: delegationId`

Resolution is by `delegationId` only, the id `Task` already returns and
`TaskWait` accepts, with a stable internal `delegateSessionId` chaining runs and a
reverse map that also resolves ids from the middle of a chain.

### 2. Chains, not records, are the unit of resumability

A chain is one `delegateSessionId` plus its ordered `Task` toolCallIds, and
reconstruction selects every child row whose `parentToolCallId` is in the chain
with a matching `agentName`. `DelegationRecord` gains `delegateSessionId`, plus
`resumedFrom` and `modelChangedFrom` when a run continues a chain.

### 3. Context reconstruction is a pure function

`packages/agent-runtime/src/delegation-history.ts` selects the chain's rows,
synthesizes the original `task` as the first user message from the first `Task`
row's arguments, converts with the delegate's own binding, and gates on a read
budget. Transport identity is `model.provider` / `model.id`, not the account row
id, which would make restored same-model reasoning look foreign; `SubagentRun`
gains `initialMessages?` and is otherwise a normal run under
`MAX_SUBAGENT_CONCURRENCY` with its own `delegationId`, report, and counters.

### 4. Validation is visible, never thrown

Each pre-run failure is a tool error the model can act on: an unknown id reports
`Unknown delegation "<id>"` with the resumable list, a running chain is never
queued, `stopped` and `aborted` runs are not resumable, a mismatched `Task.agent`
lists alternatives, `Task.model` on a resume is refused, and an over-budget chain
reports `Delegation <id> has read too much to resume cheaply`. No separate code
distinguishes evicted from never-existed, because the model's action is the same.

### 5. Only `completed` and `failed` are resumable

A failed run's reads still count and its failed assistant row is dropped like any
error row, while `stopped` and `aborted` encode an explicit Stop or disposal. A
terminal parent error settles interrupted delegates as `failed` with
`SUBAGENT_PARENT_FAILED`, which preserves manual resume eligibility (#680).

### 6. One live record per chain, ever

There is no queuing and no message append: a resume while the chain runs is
rejected with the `TaskWait` error, so a chain stays a strict straight line.

### 7. Resumable chains are bounded, LRU, per agent name

`MAX_RESUMABLE_CHAINS_PER_AGENT = 2`, chains are exempt from
`pruneFinishedDelegations`, and exceeding the bound evicts the least-recently-used
whole chain at settlement, registry entry and reverse-map entries together. A
chain whose latest run still works is never evicted, and no tombstones are needed
because `delegationId` is a random UUID.

### 8. Read budget gates chain growth

A chain has no compaction of its own, so one whose cumulative read volume exceeds
`MAX_RESUMABLE_READ_LINES` (50,000) silently leaves the resumable list and the
next delegation starts cold. Reads are counted from `Read`, `Glob`, `Grep`, and
`BrowserPreview` rows when the list is built.

### 9. The parent discovers a resumable list through `TaskList`

`TaskList` reports agent name, delegation id, objective, and files read, listing
only settled in-budget chains. The list stays out of the system prompt because it
changes on every settlement and would invalidate the cached request prefix
(ADR 0337), and a failed resume names the reusable ids in its own error.

### 10. Same session only

`resume` resolves only against the current session's transcript; sharing facts
across conversations stays in the prompt (ADR 0165).

### 11. Definition edits take effect on resume, with a diagnostic

An edited definition applies as-is on resume, matching the catalog's "editing
takes effect on the next prompt" semantics, and the change is recorded in the
delegation lifecycle details without storing a snapshot.

### 12. Chain index is rebuilt from the transcript on startup

Persisted `Task` row arguments carry the links, so session launch rescans and
rehydrates the index. Agent names are normalized on rebuild, a `running` row
rebuilds as `interrupted`, and the model binding is matched by model id since no
key is persisted.

### 13. The transcript renders a chain as one continuous conversation

A resumed card shows the chain's rows as consecutive task and reply turns with no
"resumed" badge, counters start at zero, and `details.resumedFrom` keeps the link
auditable.

## Consequences

- `Task`'s schema widens by one optional field, and `resume` omitted is exactly
  today's behavior.
- The delegate→parent boundary is untouched: reconstructed rows seed only the
  delegate's context, and `parentToolCallId` rows are still skipped when the
  parent's context is rebuilt.
- No new storage schema, tables, or event types; a resumed run is billed and
  bounded like a fresh one, and an over-budget chain degrades to a cold start.
