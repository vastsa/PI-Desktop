# ADR 0279: Resumable subagent delegations

- Status: Accepted for implementation
- Date: 2026-09-17
- Deciders: PI-Desktop core
- Related: [ADR 0062](0062-bounded-subagents-behind-a-task-tool.md) ·
  [ADR 0089](0089-proactive-background-subagent-delegation.md) ·
  [ADR 0119](0119-event-driven-subagent-timeouts.md) ·
  [ADR 0165](0165-withdraw-a2a-peer-stack.md) ·
  [03-runtime/02-agent-runtime.md](../spec/03-runtime/02-agent-runtime.md) §5f
- Amends: ADR 0062 (the `task` tool contract) and ADR 0089 (the delegation
  lifecycle). Both are preserved — every existing boundary still holds; this
  adds one opt-in parameter and one piece of bookkeeping.
- Tracking: #513

## Context

Delegation as built by ADR 0062 and ADR 0089 spawns one `SubagentRun` per `task`
call. Each run starts with `messages: []` (`packages/agent-runtime/src/subagent.ts`)
and is single-use. A delegate's transcript rows are persisted — they carry
`parentToolCallId` and `agentName` and land in the session transcript — but
nothing ever reads them back into a delegate, and the session runtime skips them
when it rebuilds model context (`runtime.ts`, `if (m.parentToolCallId) continue;`).

That makes every `task` call a cold start even when the parent delegates the
same subagent for the same files twice. The context the first run bought —
which files it read, what it found, what it already changed — is discarded, and
the second run pays for it again, or worse, works from a stale file version it
never re-reads.

The pieces to do better are already in place: the rows are persisted with
enough fidelity for a full rebuild (tool call/result pairs, thinking blocks, and
the original `task` arguments on the tool row), and the session runtime already
contains a `UiMessage[] → AgentMessage[]` converter that produces well-formed
provider messages including synthesized carriers for orphan tool rows.

## Decision

Add an opt-in `resume` parameter to the `task` tool. When present, the new
delegation is seeded with the prior delegation's reconstructed context instead
of starting empty.

### 1. `task` gains `resume?: delegationId`

Resolution is by `delegationId` only — the id the `task` result already returns
and `task_wait` already accepts. A second, stable internal key
(`delegateSessionId`) exists solely to chain the runs; it never appears in a
tool parameter, tool result, or prompt. The runtime keeps a reverse map from
every `delegationId` issued on a live chain to that chain, so an id from the
middle of a chain resolves too.

### 2. Chains, not records, are the unit of resumability

A **chain** is one `delegateSessionId` plus the ordered `task` toolCallIds that
belong to it. Each `resume` appends the new toolCallId. Child transcript rows
are keyed by `parentToolCallId`, so reconstructing a chain's context means
selecting every row whose `parentToolCallId` is in the chain and whose
`agentName` matches.

`DelegationRecord` gains `delegateSessionId`, plus `resumedFrom` and
`modelChangedFrom` on a run that continues a chain. read tracking lives on the
chain, not the record: the registry keeps one entry per `delegateSessionId` and a
secondary index from every `delegationId` on that chain to it.

### 3. Context reconstruction is a pure function

A new module (`packages/agent-runtime/src/delegation-history.ts`) owns:

- selecting the chain's rows from the session transcript,
- synthesizing the original `task` as the first user message from the first
  `task` tool row's persisted arguments,
- converting to `AgentMessage[]` with the delegate's own provider/model binding
  (a pinned delegation model is not the session model),
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
| still running | `Delegation <id> is still running`, call `task_wait` first — a resume is never queued |
| `stopped` / `aborted` | not resumable; a future revive path (out of scope here) |
| `interrupted` (the app closed mid-run) | not resumable; start a new delegation |
| `task.agent` differs from the chain's agent | name mismatch, lists available |
| `task.model` present on a resume | not allowed on a resumed run — start a new delegation to change models |
| chain exceeds the read budget | `Delegation <id> has read too much to resume cheaply` |
| the chain resolves but has no rows left to replay | the chain is dropped and reported as having no recorded history; the same id is never listed as reusable |

No new error codes for "evicted" versus "never existed": both resolve to the
same unknown-id error, because the model's only correct action is identical.

A resume keeps the chain's own model binding. The `providerId/modelId` key the
chain recorded is preferred; a chain rebuilt from the transcript only knows the
model id, which is matched against what the session has configured. Changing the
parent's own session model therefore does not strand a chain, and a delegate never
swaps models by accident. If nothing resolves the recorded binding any more, the
run continues on the binding the definition resolves to now and records the
previous model id in the delegation's lifecycle details as `modelChangedFrom`:
refusing instead would strand the chain forever, and swapping silently would hand
the same conversation to a different model with no trace.

### 5. Only `completed` and `failed` are resumable

A `failed` run's reads and findings still have value; its failed assistant row
is dropped by the converter like any other error row. `stopped` and `aborted`
encode the user's or the parent's decision to abandon that line of work, and
resuming it would contradict the stop. `interrupted` (the app closed while the
run still worked) means the same thing for this purpose: the delegate never
settled, so there is nothing trustworthy to continue. (`timed_out` is a vestigial
status — ADR 0119's timeouts were withdrawn by D328 — and is treated as `failed`
for this purpose.)

### 6. One live record per chain, ever

There is no queuing and no message-append. A chain has at most one running
record at a time; a `resume` while the chain is running is rejected with the
task_wait error above. This keeps the chain a strict straight line with no
forking successors.

### 7. Resumable chains are bounded, LRU, per agent name

`MAX_RESUMABLE_CHAINS_PER_AGENT = 2`. Chains are exempt from the existing
`pruneFinishedDelegations` oldest-first sweep. Exceeding the bound evicts the
least-recently-used whole chain when a delegation settles — registry entry and
every reverse-map entry together. A chain whose latest run is still working is
never evicted: dropping it would strand the delegate writing into it, so the
bound counts reusable chains and a live chain may momentarily push the group over
it. Tombstones are unnecessary: `delegationId` is a random UUID, so an evicted id
cannot collide with a future one.

### 8. `read` budget gates chain growth

A delegate has no compaction of its own, so an unbounded chain would eventually
overflow its own context window. Rather than trimming inside the chain, a chain
whose cumulative read volume exceeds `MAX_RESUMABLE_READ_LINES` (50,000) silently
leaves the resumable list — the next delegation for that work is a cold start,
which still works. The gate is checked when the resumable list is built, so it
costs nothing at delegation time.

Reads are counted from the delegate's read-only tool rows (`read`, `glob`,
`grep`, `browser_preview`), accumulated per chain; write-tool targets are not
counted and not listed.

### 9. The parent sees a resumable list in its system prompt

Each prompt composes the current resumable chains into the parent's system
prompt: agent name, delegation id, the one-line objective, and the files the
chain has read (capped at 8, truncated). Only settled, in-budget chains appear —
a running chain is never listed, so the parent is not lured into resuming one.

The `resume` parameter's own schema description carries the rule that reuse
requires the id; prose alone does not resume anything.

### 10. Same session only

`resume` resolves only against the current session's transcript. There is no
cross-session addressing; sharing facts between conversations stays in the
prompt, as ADR 0165 concluded when it withdrew the peer stack.

### 11. Definition edits take effect on resume, with a diagnostic

A definition edited between two delegations is applied as-is on resume — the
same "editing takes effect on the next prompt" semantics the catalog already
has — and the change is recorded in the delegation's lifecycle details. No
definition snapshot is stored; snapshots would need new persistent state and
would contradict the existing semantics.

### 12. Chain index is rebuilt from the transcript on startup

The chain registry is in memory, but the chain relationship is recoverable:
`task` tool rows are persisted with their arguments, including `resume`. At
session launch the runtime scans the transcript's `task` rows, groups them by
their `resume` links into chains, and rehydrates the secondary index. Restart
does not lose resumability.

Two details make a rebuilt chain behave like a live one. Agent names are
normalized on rebuild (`Explorer` and `explorer.md` both mean `explorer`), so the
rebuilt chain still selects its own rows and still matches `task.agent`. And each
call carries the status its own `task` row recorded: the settlement projection
rewrites that row in place, so a chain knows whether its last run was `completed`
or `failed`. A run the app closed while it still worked never settled: its row
still says `running`, which rebuilds as `interrupted` — not resumable, rather
than staying open forever. A row that records no status at all is trusted as
settled, because every `task` row this app writes carries one. The model binding
itself is not persisted as a key, so a rebuilt chain is matched to a configured
binding by model id; two accounts offering the same model id are
indistinguishable at that point.

### 13. The transcript renders a chain as one continuous conversation

A resumed delegation's card shows the whole chain's rows as consecutive turns
(task → reply → task → reply) with no special "resumed" badge. The new run's
counters start at zero; `details.resumedFrom` keeps the link auditable.

## Consequences

- `task`'s parameter schema widens by one optional field. Every existing call is
  unchanged: `resume` omitted is exactly today's behavior.
- The delegate→parent context boundary is untouched. Reconstructed rows seed the
  delegate's own context only; the parent still receives nothing but reports
  through `task_wait`, and `parentToolCallId` rows are still skipped when the
  parent's context is rebuilt.
- No new storage schema, tables, or event types. Chain identity, read tracking,
  and the model binding live on the in-memory chain; `resumedFrom` and
  `modelChangedFrom` ride the existing lifecycle details projection.
- A resumed run is billed and bounded exactly like a fresh one — same concurrency
  slot, same permission scope, same fallback models, same abort sources.
- Failure mode of the read budget is graceful degradation to a cold start, never
  a broken or oversized request.

## Out of scope (二期)

- Reviving a `stopped` / `aborted` delegation.
- In-chain compaction or placeholder substitution for old tool results.
- task queuing / work append on a running delegation.
- Cross-session resumption.
- User-visible settings for the bounds; they stay code constants.
