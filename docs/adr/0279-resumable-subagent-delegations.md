# ADR 0279: Resumable subagent delegations

- Status: Accepted for implementation
- Date: 2026-09-17
- Deciders: PI-Desktop core
- Related: [ADR 0062](0062-bounded-subagents-behind-a-task-tool.md) ·
  [ADR 0089](0089-proactive-background-subagent-delegation.md) ·
  [ADR 0119](0119-event-driven-subagent-timeouts.md) ·
  [ADR 0165](0165-withdraw-a2a-peer-stack.md) ·
  [03-runtime/02-agent-runtime.md](../spec/03-runtime/02-agent-runtime.md) §5f
- Amends: ADR 0062 (the `Task` tool contract) and ADR 0089 (the delegation
  lifecycle). Both are preserved — every existing boundary still holds; this
  adds one opt-in parameter and one piece of bookkeeping.
- Tracking: #513

## Context

Delegation as built by ADR 0062 and ADR 0089 spawns one `SubagentRun` per `Task`
call. Each run starts with `messages: []`
(`packages/agent-runtime/src/subagent.ts`) and is single-use.

## Decision

Add an opt-in `resume` parameter to the `Task` tool. When present, the new
delegation is seeded with the prior delegation's reconstructed context instead
of starting empty.

### 1. `Task` gains `resume?: delegationId`

Resolution is by `delegationId` only — the id the `Task` result already returns
and `TaskWait` already accepts. A second, stable internal key
(`delegateSessionId`) exists solely to chain the runs; it never appears in a
tool parameter, tool result, or prompt.

### 2. Chains, not records, are the unit of resumability

A **chain** is one `delegateSessionId` plus the ordered `Task` toolCallIds that
belong to it. Each `resume` appends the new toolCallId.

`DelegationRecord` gains `delegateSessionId`, plus `resumedFrom` and
`modelChangedFrom` on a run that continues a chain. Read tracking lives on the
chain, not the record: the registry keeps one entry per `delegateSessionId` and
a secondary index from every `delegationId` on that chain to it.

### 3. Context reconstruction is a pure function

A new module (`packages/agent-runtime/src/delegation-history.ts`) owns:

- selecting the chain's rows from the session transcript,
- synthesizing the original `task` as the first user message from the first
  `Task` tool row's persisted arguments,
- converting to `AgentMessage[]` with the delegate's own provider/model binding
  (a pinned delegation model is not the session model).
- a read-file / line-count budget gate.

`SubagentRun` gains `initialMessages?: AgentMessage[]`; when present it seeds
`initialState.messages` instead of `[]`. The run is otherwise a completely
normal run: it occupies a `MAX_SUBAGENT_CONCURRENCY` slot, inherits the
definition's permission scope, and settles through the existing
`settleDelegation` path with its own `delegationId`, report, and counters.

### 4. Validation is visible, never thrown

`resume` is validated before the run starts; every failure is a tool error the
model can act on:

| Condition | Error |
|---|---|
| unknown or evicted id | `Unknown delegation "<id>"` plus the current resumable list |
| still running | `Delegation <id> is still running`, call TaskWait first — a resume is never queued |
| `stopped` / `aborted` | not resumable; a future revive path (out of scope here) |
| `interrupted` (the app closed mid-run) | not resumable; start a new delegation |
| `Task.agent` differs from the chain's agent | name mismatch, lists available |
| `Task.model` present on a resume | not allowed on a resumed run — start a new delegation to change models |
| chain exceeds the read budget | `Delegation <id> has read too much to resume cheaply` |
| the chain resolves but has no rows left to replay | the chain is dropped and reported as having no recorded history; the same id is never listed as reusable |

No new error codes for "evicted" versus "never existed": both resolve to the
same unknown-id error, because the model's only correct action is identical.

### 5. Only `completed` and `failed` are resumable

A `failed` run's reads and findings still have value; its failed assistant row
is dropped by the converter like any other error row. `stopped` and `aborted`
encode an explicit Stop or runtime disposal, and resuming it would contradict
the cancellation.

### 6. One live record per chain, ever

There is no queuing and no message-append. A chain has at most one running
record at a time; a `resume` while the chain is running is rejected with the
TaskWait error above.

### 7. Resumable chains are bounded, LRU, per agent name

`MAX_RESUMABLE_CHAINS_PER_AGENT = 2`. Chains are exempt from the existing
`pruneFinishedDelegations` oldest-first sweep.

### 8. Read budget gates chain growth

A delegate has no compaction of its own, so an unbounded chain would eventually
overflow its own context window. Rather than trimming inside the chain, a chain
whose cumulative read volume exceeds `MAX_RESUMABLE_READ_LINES` (50,000)
silently leaves the resumable list — the next delegation for that work is a cold
start, which still works.

Reads are counted from the delegate's read-only tool rows (`Read`, `Glob`,
`Grep`, `BrowserPreview`), accumulated per chain; write-tool targets are not
counted and not listed.

### 9. The parent discovers a resumable list through `TaskList`

`TaskList` reports the current resumable chains: agent name, delegation id, the
one-line objective, and the files the chain has read (capped at 8, truncated).
Only settled, in-budget chains appear — a running chain is never listed, so the
parent is not lured into resuming one.

The list deliberately stays out of the system prompt. It changes on every
settlement, and rewriting instructions mid-session invalidates the request
prefix providers cache on; ADR 0337 records that trade-off and supersedes the
earlier "compose the list into the prompt" decision.

### 10. Same session only

`resume` resolves only against the current session's transcript. There is no
cross-session addressing; sharing facts between conversations stays in the
prompt, as ADR 0165 concluded when it withdrew the peer stack.

### 11. Definition edits take effect on resume, with a diagnostic

A definition edited between two delegations is applied as-is on resume — the
same "editing takes effect on the next prompt" semantics the catalog already has
— and the change is recorded in the delegation's lifecycle details. No
definition snapshot is stored; snapshots would need new persistent state and
would contradict the existing semantics.

### 12. Chain index is rebuilt from the transcript on startup

The chain registry is in memory, but the chain relationship is recoverable:
`Task` tool rows are persisted with their arguments, including `resume`. At
session launch the runtime scans the transcript's `Task` rows, groups them by
their `resume` links into chains, and rehydrates the secondary index.

Two details make a rebuilt chain behave like a live one. Agent names are
normalized on rebuild (`Explorer` and `explorer.md` both mean `explorer`), so
the rebuilt chain still selects its own rows and still matches `Task.agent`.

### 13. The transcript renders a chain as one continuous conversation

A resumed delegation's card shows the whole chain's rows as consecutive turns
(task → reply → task → reply) with no special "resumed" badge. The new run's
counters start at zero; `details.resumedFrom` keeps the link auditable.

## Consequences

- `Task`'s parameter schema widens by one optional field.
- The delegate→parent context boundary is untouched.
- No new storage schema, tables, or event types.
- A resumed run is billed and bounded exactly like a fresh one — same
  concurrency slot, same permission scope, same fallback models, same abort
  sources.
- Failure mode of the read budget is graceful degradation to a cold start, never
  a broken or oversized request.

## Out of scope (二期)

- Reviving a `stopped` / `aborted` delegation.
- In-chain compaction or placeholder substitution for old tool results.
- Task queuing / work append on a running delegation.
- Cross-session resumption.
- User-visible settings for the bounds; they stay code constants.
