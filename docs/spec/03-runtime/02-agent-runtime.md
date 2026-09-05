# 02. Agent Runtime

## 1. Goal

Applied decisions: **D002/D003/D008/D158/D189/D190/D193/D194/D278**.


Wrap pi into a product runtime that desktop layers can consume safely.

Core packages:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`

## 2. Runtime placement

Agent loop runs in a **Node/TypeScript pi sidecar**, not in renderer.

```text
packages/agent-runtime/*
apps/desktop/electron/* (supervisor)
crates/host-core (tool execution + permissions)
```

## 3. Core objects

### 3.1 PiRuntime (Node)
- init models/providers
- create Agent
- bind tool bridge
- subscribe/normalize pi events

### 3.2 AgentHostFacade (Electron main)
- session routing
- process supervision
- IPC translation

### 3.3 Host Tool Bridge (Rust)
- receives tool call requests
- applies permission policy
- executes builtin/plugin tools
- returns normalized tool results

## 4. Runtime API (package-level)

```ts
interface AgentRuntime {
 prompt(input: PromptInput): Promise<{ turnId: string }>
 requestGracefulStop(): { requested: boolean }
 abort(turnId?: string): Promise<void>
 getStatus(): RuntimeStatus
 dispose(): Promise<void>
 subscribe(handler: (event: NormalizedAgentEvent) => void): () => void
}
```

`requestGracefulStop()` is a one-shot request for the active runtime. The pi
loop evaluates it after `turn_end`, once the current assistant response and
tool batch have completed, and emits a normal `agent_end` before another model
request. It does not cancel an active provider stream or running tool. An idle
runtime returns `{ requested: false }`; immediate `abort()` remains the
separate cancellation path.

## 5. Prompt flow

1. load the durable session and reject a missing session
2. resolve that session's mode/provider/model and project binding (app/current
   workspace defaults are legacy fallback only)
3. resolve the complete models.dev metadata record for the exact provider/API
   URL and model and clamp the durable session thinking level to its nearest
   supported value; an ID absent from the snapshot uses the explicit generic
   fallback
4. validate model/secret availability
5. reject if session busy; the renderer queues a user-facing next prompt and
   does not call this path until the current session reaches `agent_end`
6. validate structured attachments at Electron main's session-bound path
   boundary, persist image bytes by SHA-256, and retain only attachment refs in
   the durable user message. Only an image that is within the 20 MiB inline
   bound for a vision model is read into memory; larger images use streamed
   hashing/copying and the existing safe path fallback
7. snapshot the effective shell ID and dialect for the turn
8. start pi turn with the resolved session configuration and effective
   thinking level; HTTP 429 setup and stream failures use the runtime-owned
   silent five-retry budget, while other transient transport/provider failures
   share a runtime-owned bounded four-retry budget across the setup and stream
   phases (D127, D186, D245, D258)
9. stream normalized answer and thinking events to UI
10. on tool calls, delegate to Rust host bridge with the durable `sessionId`;
    host resolves the session-bound workspace root
11. if pi finishes a message with `stopReason: "error"`, finalize any partial
    assistant bubble with a structured `UiMessage.error`, persist it in the
    transcript, and emit a normalized lifecycle `error` event carrying the
    same provider `AppError`; even a failure with no answer text remains a
    visible assistant error message
12. finalize and persist successful answer/thinking blocks independently

The runtime constructs exactly one pi `Agent` per durable session. Plan does
not select a second model, planner service, permission implementation, or
runtime. The same Agent changes its planning state and tool registry after a
host-confirmed transition.

### 5d. Bounded provider recovery and diagnostics (D186, D245, D259, ADR 0091, ADR 0128)

Provider request setup and stream delivery are separate failure phases, but
HTTP 429 handling is one logical-turn policy. pi-ai's nested adapter retry is
disabled for this path so the runtime can share one budget across both phases.

`PROVIDER_RATE_LIMITED` receives at most five retries after the initial
attempt, for six provider attempts total. A setup 429 is retried inside the
provider stream adapter. A mid-stream 429 removes the failed assistant from
the next model context and calls `continue()` in the same turn. Both phases
claim the same counter, so a setup 429 followed by a stream 429 cannot reset or
multiply the budget. The captured response status is applied before classifying
the provider message in both phases, so a generic 429 body still enters the
429 budget while known non-retryable classifications remain terminal. The main
session and builtin subagents use the same controller and policy.

429 retries are silent: no intermediate assistant error, lifecycle `error`,
`turn_end`, `agent_end`, or duplicate assistant bubble reaches the UI. The
visible assistant message id is reused when a retry starts, replacing any
partial content in one bubble. End events are emitted once by the final
successful or exhausted attempt. An abort during the wait cancels the timer
and prevents the next provider request.

The delay follows the OpenCode-style order `retry-after-ms`, `retry-after`
seconds, `retry-after` HTTP-date, then exponential backoff. The fallback starts
at 2 seconds and grows exponentially with up to 25% positive jitter; every
server or calculated value is capped at 30 seconds. The runtime captures the
failed response status and headers from fetch because pi-ai's ordinary response
callback only covers an established response.

Non-429 transient failures share their own bounded logical-turn budget of four
retries after the initial attempt, for five provider attempts total. The budget
is shared by request setup and stream delivery, so a fault that moves between
phases cannot reset or multiply it, and it is separate from the 429 budget. It
admits exactly `NETWORK_ERROR`, `TIMEOUT`, `STREAM_FAILED`, and retryable
`PROVIDER_ERROR` — including a gateway `502`/`503`/`504` that arrives before
headers or mid-stream. Authentication, model-selection, malformed-request,
context, and other non-retryable errors do not enter either provider replay
path, and a non-retryable `PROVIDER_ERROR` from a malformed 400/422 request
stays terminal.

The non-429 delay honors the server first: `retry-after-ms`, `retry-after`
seconds, then `retry-after` HTTP-date, capped at 8 seconds. Captured headers are
retained for every status that can carry a usable delay (429, 408, 409, and
5xx), not for 429 alone. Without a usable header the wait is a plain doubling
schedule of 1, 2, 4, then 8 seconds, identical in the request and stream phases
so a fault that moves between them keeps one predictable rhythm. The schedule is
deterministic — no jitter — because it paces one failed request rather than a
synchronized rate-limit burst. A server-stated delay wins outright, including one
shorter than the scheduled wait.

Only the failed request is replayed. The session, its transcript, and its tool
state are untouched: the failed assistant is removed from the next model context
and the same visible message id is reused, so a retry never restarts the turn or
re-runs a completed tool call.
Each retry is silent and abortable. The main session, builtin subagents, and
one-shot composer enhancement use the same codes, budget size, and precedence.

When the 429 budget is exhausted, the final assistant error and lifecycle
`error` are emitted once. Provider failures carry bounded diagnostics in
`AppError.details` when available: `phase` (`request` or `stream`),
`providerStatus`, `providerCode`, `providerWaitMs`, `streamMs`, and
`retryAttempt`. For a persistent 429, `retryAttempt` is `5`; for a persistent
non-429 transient failure it is `4`. Credentials and unrestricted response
bodies never enter the event or log.

### 5e. Silent-turn recovery

A turn that ends with no tool call and no visible assistant text is invisible
to the user: reasoning is never rendered, so a conclusion written only there
did not arrive. 15 of 255 recorded sessions ended a turn that way, and the
user's only recourse was typing "继续".

The runtime detects it at `message_end`: the stop was neither an error nor an
abort, the message requested no tools (no `toolCall` content part), and the
visible text is blank after trimming. Reasoning content does not exempt a turn
— a thinking-only turn is exactly the case that needs recovery.

Recovery mirrors §5d and is bounded the same way: at most one re-run per run.
The silent assistant is dropped from the model context (`continue()`
refuses a transcript ending in an assistant message, and an empty one is not
worth resending), a short no-output instruction is appended to the system
prompt for that one continuation, and the bubble id is reused so a recovered
turn leaves no empty row behind. The silent attempt's `turn_end` and
`agent_end` are suppressed; the re-run emits the single terminal lifecycle.

Recovery is armed inside `message_end` and carried out once the loop is idle,
so it belongs to every entry point that drives the loop — a user prompt and an
approved plan or goal execution alike. Each entry point clears the recovery
state before it starts and runs the pending recovery after `waitForIdle`,
through one shared implementation of each half. Skipping either half ends the
run with its lifecycle still suppressed and no recovery attempted, which
reaches the user as a session that stopped mid-work with no error and no retry
action. §5d overflow and provider-stream retry ride the same contract, and a
suppression flag left behind would swallow the *next* run's terminal events.

The one-shot instruction rides on the agent's system prompt rather than the
`prepareNextTurn` hook, because that hook only shapes turns inside a live run
and this run has already ended. It is removed afterwards unless a path-scoped
instruction reload rewrote the prompt meanwhile, in which case the newer
rebuild wins.

If the re-run is silent too, the turn ends as a visible assistant error with
retriable `EMPTY_MODEL_RESPONSE`, which gives the transcript its normal retry
action. No empty assistant message is persisted in either case.

Decision D193; see E2E-146.

### 5.1 Context checkpoint protection (D158/D203, ADR 0030/0049/0061/0064)

The complete visible transcript and the model context are separate views of
the same session. A durable checkpoint summarizes older model context while
the renderer continues to show every original user, assistant, and tool row.

PI-Desktop reuses pi-agent-core's `convertToLlm`, `estimateContextTokens`,
`prepareCompaction`, and `compact` primitives, and applies the same session
context projection pi used to export as `buildSessionContext` (slice from the
newest compaction, then `compactionSummary` before the retained tail). pi 0.85
moved that helper off the public package export and made the remaining
internal builder async for custom-entry projectors; the desktop runtime keeps
a synchronous local copy because it synthesizes only message and compaction
entries. The desktop runtime owns when they run and how the result crosses the
Rust storage boundary; OpenCode DCP is an AGPL-3.0 behavioral reference only,
not a linked or copied dependency.

Compaction follows Codex's mechanism (ADR 0064): it always happens inline at a
turn boundary, the model can request it through `new_context`, every compaction
adds a transcript row and raises one warning toast, and there is no
pre-computation anywhere.

pi 0.84.4+ invokes `prepareNextTurn` only when the loop will start another
assistant turn in the same run — including between a completed tool batch and
the follow-up model request. A new user prompt still compacts before its first
provider request through `automaticCompactionNeeded` in `prompt()`.

For every pi loop turn:

1. pi emits and awaits `turn_end` after the assistant message and all tool
   results for that turn are complete
2. PI-Desktop rebuilds the context from the full transcript plus the newest
   valid checkpoint and estimates the next request budget
3. below the hard boundary, and with no pending model request, the next turn
   proceeds unchanged
4. at or above the hard boundary, or when the model called `new_context`,
   compaction runs synchronously before the next provider request. In the
   summary family, generation is mandatory; the runtime preflights the summary
   input against the model window and skips a request that cannot fit. An
   automatic summary failure first attempts a deterministic retained-tail
   checkpoint, while manual compaction still reports
   `CONTEXT_COMPACTION_FAILED`
5. successful generation or deterministic recovery first appends the
   checkpoint through host-core, then installs its summary plus the applicable
   retained tail as the runtime context for the next provider request; a
   hard-boundary checkpoint is re-estimated before it is persisted and again
   before continuation, and cannot authorize the next request unless it is
   below the hard budget

Checkpoint generation and installation are separate operations.
`buildCheckpoint` runs the preparation, budget preflight, and summary request
without persisting anything or changing the active checkpoint; installation
re-estimates, appends through host-core, updates the active checkpoint, and
emits `compaction_end`. The blocking path composes the two back to back.

**What survives a checkpoint.** The model context after a compaction is the
summary plus, at most, one **user** message; assistant and tool messages are
dropped from model context and remain in the visible transcript. pi's
`prepareCompaction` still chooses the cut point, so its turn-boundary and
split-turn handling are preserved, but the runtime then folds the split-turn
prefix and the recent tail back into the summary input, so the summary covers
the whole compacted range and nothing crosses the boundary uncovered.

The retention mode is selected from the lifecycle that requested compaction:

- An `active_turn` checkpoint is created while the provider must continue the
  current task after a tool result, a `toolUse` turn, or overflow recovery. It
  carries only the latest user message from the compacted range, up to the
  retention limit below; if that message crosses the limit it is truncated
  rather than dropped (`[checkpoint truncated: this message crossed the
  retained context budget]`).
- A `completed_turn` checkpoint is created at a terminal turn boundary, before
  a new user prompt, or for manual compaction. It carries no naked historical
  user messages. The summary is authoritative for completed work, and the next
  user prompt is the only new task after the checkpoint.
- The `fresh_window` family remains the deliberate no-summary exception from
  ADR 0064 and always carries an empty tail.

The retained-tail mode is stored in the checkpoint's opaque `details` field so
restart preserves the same task boundary. Checkpoints written before this
field existed are normalized to their latest user message only. Dropping an
assistant message also drops its tool calls, so no orphaned tool call can reach
the provider. The retained tail is re-estimated with the summary before
persistence and before continuation, so an oversized request still cannot pass
the guard.

**Two compaction families.** Both run the same lifecycle — budget
re-estimation, host-core append, `compaction_end`, transcript row, warning:

- `summary` (the default) requests a summary from the model;
- `fresh_window` requests nothing and installs a checkpoint with an empty
  retained tail and a fixed marker text saying the history was reset without
  being summarized.

The family is resolved from a construction option, then
`PI_DESKTOP_COMPACTION_STRATEGY`. It is not a setting, is absent from
`AppSettings` and i18n, and exists so the no-summary mechanism is implemented
and testable.

**Model-facing surface.** `new_context` takes no parameters and starts a new
context window at the next turn boundary; it never clears or resets environment
state. Two budget reminders are appended to the current turn's system prompt,
each at most once per checkpoint window and reset when a checkpoint is
installed: one when the remaining budget falls to
`clamp(hardLimit * 0.15, 8k, 32k)`, asking the model to start closing out, and
one at 2,000 tokens remaining, telling it to write down whatever must survive.
Neither reminder is persisted or shown in the transcript.

The hard boundary is the model context window minus request headroom.
Headroom is the maximum of a 16,384-token reserve floor, model maximum output
capped at 25% of the context window, and a 5% safety margin. The reserve floor
is itself capped at half the window. The cut-point target passed to pi is
derived from the model window as 20% of the hard budget clamped to
8,000–64,000 tokens, then capped at half the hard budget; it decides where the
boundary falls, not what survives it. The active-user retention limit is 20,000
tokens, capped at half the hard budget so retention alone cannot fill a small
window and leave the summary no room. None of these values are configurable.

The incoming user prompt participates in budgeting before the first provider
request. If normal compaction fails during an automatic threshold or overflow
recovery, the runtime persists a short recovery checkpoint with the previous
summary (when available) and an aggressively bounded applicable tail. The
complete transcript remains durable and visible, while the next model request
receives only that recovery checkpoint and applicable tail. The lifecycle event marks
this as `fallback: "retained_tail"` so the renderer can show a warning rather
than a false success. If the fallback cannot be prepared, persisted, or kept
below the safe budget, the user row and an assistant error remain durable and
no provider request starts. Provider-reported context overflow is the last
recovery layer: omit the failed assistant from model context, compact once,
and retry once. A second overflow remains terminal. Bedrock's
`prompt is too long: N tokens > M maximum` form maps to this path.

Automatic protection is always enabled and is not user-configurable. The
runtime still accepts a construction-time override that disables it, used by
tests; persisted `contextCompaction` settings are ignored so a session cannot
be left with the guard off and no way to restore it. Manual `/compact` remains
available while the session is idle. Checkpoint generation is abortable and
counts as running state until durable persistence completes.

## 5b. Operating mode and planning state

- Default product mode: **Agent**
- The product selector is **Agent | Plan | Goal**; the internal conversation page
  may still use `page = "chat"`
- Mode is session-scoped and persisted with session metadata
- Thinking level is session-scoped and persisted with session metadata
- Host configuration is mutable only while the session is idle. The renderer
  keeps mode/provider/model/thinking/permission controls editable during a run,
  treats the latest selection as next-turn state, and flushes one full
  configuration after the terminal event.
- Changing mode/provider/model/thinking level applies to the next turn and
  recreates the pi runtime when any runtime-affecting configuration changes;
  no in-flight runtime observes a queued renderer choice.
- The live planning indicator follows the turn that is actually running. A
  mode choice staged while a turn runs never flips the projected
  `planning`/`inactive` state mid-turn: the renderer keeps the state of the
  in-flight turn and only moves it to the staged contract mode after the
  terminal event flushes the configuration, so `Plan / planning` surfaces
  when the next prompt starts under the new mode.

The live planning state is derived and projected as:

```ts
type OperatingMode = "agent" | "plan" | "goal";
type ProposalKind = "plan" | "goal";
type PlanningState =
  | "inactive"
  | "planning"
  | "awaiting_approval";
type PlanExecutionState = "queued" | "running" | "completed" | "interrupted";
```

Plan and Goal are the two **contract modes** (D198). They share one durable
approval table, one projected `PlanningState`, one approval surface, and one
execution queue; a `kind` discriminator (`plan` | `goal`) on the proposal selects
the prompt, the artifact directory, and the user-facing copy. `Agent` is the only
mode with no kind, and is the only mode that executes freely. Because the
projection is shared, `planning` and `awaiting_approval` are always read together
with the kind to know which durable mode a session is in.

`Agent / inactive` enters `Plan / planning` either when the user selects Plan
while idle or when the Agent calls `EnterPlanMode`. In Plan, the Agent can
inspect, use context controls, run Bash through the selected permission mode,
and call `SubmitPlan(title, markdown, question)`. Host-core preserves the
submitted Markdown bytes in a new immutable
`.pi/plan/<unique-name>.md` artifact, records its relative path/hash/size and
structured title/question in `plan_approvals`, and moves the live state to
`awaiting_approval`.

Approval has only `approve` and `reject`. Approval commits `mode = agent`, the
explicit permission mode, an execution ID, and `execution_state = queued` on
the same `plan_approvals` row in one host transaction. The
same Agent then receives a fresh model turn with the Agent tool set. Reject,
absolute expiry, a pending interruption, stale response, or persistence
failure closes the approval row and returns the live state to editable
`Plan / planning` without granting execution tools. A later accepted Plan prompt
is a new turn: earlier `SubmitPlan` calls remain historical immutable
checkpoints, and the Agent must call `SubmitPlan`
once with a new complete Markdown snapshot to create a new artifact. If approval
already committed and a queued/running execution is interrupted, durable mode
remains Agent and the execution is not replayed.

Manual mode and configuration selection may be staged by the renderer while a
turn runs, but host persistence remains idle-only. Selecting Agent is an
intentional user override and does not synthesize a plan or approval. Each
session has one active turn, one pending approval, and one queued/running
execution; a second prompt or execution is rejected, while staged
configuration is submitted only after the session is idle.

`Agent / inactive` enters `Goal / planning` the same two ways, by user selection
while idle or by the Agent calling `EnterGoalMode`. Goal has the identical tool
surface as Plan, except that its submit tool is
`SubmitGoal(title, markdown, question)` and its artifact is written to
`.pi/goal/<unique-name>.md`. The submitted Markdown is a **goal contract** — the
outcome to reach, the acceptance criteria that prove it was reached, and the
boundaries that must not be crossed — not a list of implementation steps. A
submit tool is rejected with `PLAN_KIND_MISMATCH` when the session's active kind
is the other one, and with `PLAN_NOT_ACTIVE` when no contract is active.

Goal approval commits exactly what Plan approval commits: `mode = agent`, the
explicit permission mode, an execution ID, and `execution_state = queued` on the
same row. The queued execution instruction differs by kind. An approved plan is
replayed as steps to follow; an approved goal instructs the Agent to choose its
own approach, verify every acceptance criterion by running the checks the
contract names, keep working while a criterion is unmet and an untried approach
remains, stop early only when a boundary blocks it, and close with a
criterion-by-criterion report of what was met and the evidence observed.

## 5c. Thinking capability and stream contract

- Canonical levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`,
  and `max`.
- The bundled models.dev release snapshot is authoritative for published
  reasoning support, thinking-level mapping, limits, input/output modalities,
  pricing, and other model metadata. pi-ai remains responsible for request
  serialization and adapter compatibility.
- Provider configuration cannot override known-model semantics. Unknown
  free-form ids remain runnable through a generic text-only, non-reasoning
  model and therefore expose only `off`.
- Unsupported requested levels use the selected models.dev model's
  nearest-supported-level rule: scan upward first, then downward. A
  non-reasoning provider always resolves to `off`.
- Vision support is resolved from the same models.dev record: only
  `input.includes("image")` enables image transport. Unknown/custom model ids
  remain conservative text/path models even when discovery metadata claims
  `vision`.
- The effective level is passed to the pi `Agent`; provider-specific request
  serialization remains pi-ai's responsibility.
- Pi `thinking` blocks become `UiMessage.thinking` and
  `message_update.deltaThinking`. They never append to `content` or
  `deltaText`.
- Restored assistant history reconstructs separate text and thinking blocks
  before the next turn.
- Restored history also reconstructs tool call/result pairs from persisted
  tool rows (`toolCallId`/`toolArgs`/`toolResult`), so a recreated runtime
  keeps its full working context — file contents read, command output —
  instead of collapsing to bare chat text (D127). An interrupted tool row
  restores as an errored result; a tool row whose assistant row was lost
  gets a synthesized call-only assistant carrier so call/result pairs stay
  well-formed for every provider API.
- Vision runtimes hydrate persisted image refs only from the session-bound
  attachment, scratch, and project roots. Images within the 20 MiB inline
  safety bound become transient pi-ai image blocks; oversized or unavailable
  images become safe `@path` fallbacks. Oversized history hydration copies
  files without first loading their contents into memory. Base64 is never
  restored into durable UI messages or transcript records.
- Failed assistant messages remain durable diagnostic transcript entries but
  are never restored into pi model context on a later turn.
- Restored checkpoints clear provider usage from retained assistant messages
  for budgeting. That usage measured the pre-compacted request and must not
  make the summary + tail appear as large as the discarded context.
- Runtime recreation and model changes restore the newest valid checkpoint.
  Truncation keeps it only when its boundary remains in the live transcript;
  a fork copies/remaps it only when the child includes that boundary.
- A forked session receives a new session id and no shared runtime. Its first
  prompt creates a fresh pi runtime and restores context only from the child
  transcript, including the remapped tool call/result pairs.
- Message-scoped assistant Fork/Edit follows the same rule: the child
  transcript may stop at or replace the selected assistant response, but its
  next prompt cannot reuse the source session's runtime/provider cache because
  the session id and remapped transcript identities are independent (D134).

## 5f. Subagent delegation (D201, ADR 0062, ADR 0089)

The session Agent can hand separable pieces of work to delegates that run in
their own context, in the background, and report back on demand.

**Catalog.** Definitions are Markdown documents from two sources: the four
builtins shipped inline in `agent-runtime` (`explorer`, `code-reviewer`,
`test-runner`, `fixer`) and the global user documents under
`~/.agents/subagents/*.md`. There is no project-level subagent directory and
`.pi/agents` is not scanned for capabilities. User documents are filtered by
the app-local enabled state before they reach the loader. Electron main loads
the global catalog on every launch and passes `subagents` /
`subagentProviders` in the sidecar params, so editing a definition takes effect
on the next prompt. The catalog is capped at `MAX_SUBAGENT_DEFINITIONS` (16);
a malformed or unreadable document becomes a launch diagnostic and never fails
the launch.

Frontmatter adds `permission: inherit | ask | accept-edits | auto` (default
`inherit`), which controls the scope the delegate's tool calls resolve under
instead of the session mode (§5f.1). It also accepts `idle-timeout` and
`max-duration` watchdog overrides. Only builtin and user definitions may
declare a permission scope —
both express a choice the user already made, whereas a project definition
arrives with the repository, so honoring its scope would let cloned code grant
itself `auto`. A project document that declares a non-`inherit` scope keeps
loading with a warning and its delegates run under the session's effective
mode; a user who wants the scope copies the document into their own agents
directory. Builtins, including `fixer`, do not override the parent session by
default, so the one write-capable builtin follows `auto` completely (including
explicit external paths) while `ask` and `accept-edits` retain their normal
approval behavior. An explicit builtin or user scope remains an intentional
override.

**Tools (ADR 0089).** Delegation is a four-tool lifecycle, built only in Agent
mode and only when the catalog is non-empty, and all four belong to the Agent
core set rather than the on-demand catalog of §7.1:

- `Task(agent, task, description?, model?)` — validates its arguments (an
  unknown `agent`, an empty `task`, an unresolvable model pin and a definition
  whose tools are all unavailable each return a tool error explaining the
  failure rather than throwing), starts the delegate **in the background**, and
  returns immediately with a `delegationId`. Starting fails with a tool error
  when the session already runs `MAX_SUBAGENT_CONCURRENCY` (10) delegates.

  The `Task` tool accepts an optional `model` parameter
  (`"provider/modelId"`) that overrides the delegate's model for that run.
  Resolution priority: Task.model parameter → definition frontmatter pin →
  session model. The parent agent sees a model summary in the system prompt
  listing all models marked `availableForSubagents` in provider settings.
  When a model key is not pre-resolved, the runtime asks Electron main to
  resolve it on-demand via the `provider.resolveSubagentModel` RPC.
- `TaskWait(delegationIds?, mode?, minCompleted?, timeoutSeconds?)` — converges
  on running delegations (defaults to all of them) and returns their reports;
  `mode: "any"` with `minCompleted` converges as soon as the first N settle.
  Settled delegations return immediately, so re-reading a report by id is
  cheap. The joined result is bounded to `MAX_TASKWAIT_RESULT_CHARS` (50k).
  `timeoutSeconds` defaults to 600 and is clamped to 900: the wait blocks the
  turn, so the ceiling is what bounds how long a session can look hung. Expiry
  is not a failure — the delegates keep running and the wait returns the
  finished reports plus a note saying so and to call again — so a low ceiling
  costs one round-trip and keeps Stop responsive. Detecting a hung delegate is
  the idle watchdog's job, not this timeout's, which is why the idle default is
  deliberately shorter than this one.
- `TaskList()` — reports every delegation of the session with status.
- `TaskStop(delegationIds?)` — stops running delegations (defaults to all);
  waits for each abort to settle, then persists `status: "stopped"` with
  `completedAt` on `details.stopped[]`. Stopped delegations read as `stopped`.

**Delegate loop.** A `SubagentRun` is a second pi `Agent` in the same sidecar
process with the definition's system prompt, its (possibly pinned)
provider/model, its declared tools, and the same host connection. It runs under
the same bounded provider retry policy as the parent. `maxTurns` is an optional
per-definition backstop (maximum 80); omitted, `none`, or `0` means unlimited
turns. The built-ins declare one sized to their job — `explorer` 60,
`code-reviewer` 50, `test-runner` 40, `fixer` 80 — so a delegate that loops
without converging ends as `truncated` with its partial report instead of
running until the duration limit. The built-in `explorer` declares `Read`,
`Glob`, `Grep`, and `Bash`, while `code-reviewer` remains read-only. Its statuses are `completed`,
`truncated`, `failed`, `aborted`, `timed_out` and the registry-only `stopped`;
the terminal ones surface through `TaskWait`, whose text is
the report (bounded to `MAX_SUBAGENT_REPORT_CHARS`, 12k) and whose details
carry `delegationId`, `agent`, `status`, `startedAt`, `completedAt` when
settled, `turns`, `toolCalls` and, on failure or timeout, `error`. `startedAt` and
`completedAt` are runtime timestamps in milliseconds and are the source of
truth for renderer delegation duration; the immediate `Task` tool-call
duration only covers starting the background work.

**Delegate watchdogs.** Every run has a 300-second idle timeout and a
21,600-second (6-hour) total duration limit. A definition may override them
with `idle-timeout` (clamped to 10–21,600 seconds) and `max-duration` (clamped
to 60–21,600 seconds); non-numeric values warn and use the defaults.

The idle timeout bounds *silence*, not slowness. Every agent event counts as
activity, down to one streamed token arriving as `message_update`, so a
delegate that keeps producing output never trips it however long its turn runs.
The idle timer is additionally paused from `tool_execution_start` until its
matching `tool_execution_end`, so a long build or test command cannot expire it
either, while the duration timer continues through tool execution. Only a
delegate that emits nothing at all for the whole window is treated as hung.
Because the window measures dead air rather than work, the default is sized
from observed provider latency rather than from how long work may take: a
delegate is silent from its last streamed token until its next response
begins, and that wait has been measured at 174 seconds at p99.9. The
300-second default clears that with margin while staying well below the
600-second `TaskWait` default, so a stuck delegate settles as `timed_out`
within a single wait instead of holding the parent for a full window and
beyond.

Idle expiry returns `timed_out` with `SUBAGENT_IDLE_TIMEOUT`, and
duration expiry returns `timed_out` with `SUBAGENT_DURATION_TIMEOUT`; both
include the latest partial assistant output when available and abort the
delegate immediately. Fatal provider/stream errors, parent aborts, and
explicit `maxTurns` retain their existing `failed`, `aborted`, and `truncated`
outcomes.

**Model pins.** `model: <provider>/<model>` in the frontmatter is resolved once
per launch in Electron main, where credentials and the models.dev snapshot live, against
provider id, vendor key or display name, and capped at
`MAX_SUBAGENT_PROVIDERS` (8) distinct providers. An unresolvable pin is omitted
from the binding map on purpose; the runtime turns the missing entry into a tool
error naming the pin, and never falls back to the session model. A definition's
`thinkingLevel` is clamped against the resolved model with the same
nearest-supported rule as §5c.

**Events and context.** Every event a delegate emits carries
`parentToolCallId` and `agentName` on its envelope, and Electron main copies both
onto the persisted row. When the runtime rebuilds model context it skips every
row with `parentToolCallId`: the parent only ever saw reports through
`TaskWait`, and replaying delegate rows would both contradict that and
reintroduce the context cost delegation exists to avoid.

**Turn ownership.** A delegate's lifecycle never reaches Electron main's turn
handling. Delegation is expected to converge inside the turn — the system
prompt instructs the parent to continue its own work after `Task` and to
`TaskWait`/`TaskStop` before answering — and the runtime aborts any delegate
still running when the run ends, when the parent aborts, or when the runtime is
disposed.

### 5f.1 Delegate permission scope (ADR 0089)

A delegate's tool calls flow through the same host `tools.execute` path as the
parent's. When the definition declares a non-`inherit` `permission` **and its
source is `builtin` or `user`**, the sidecar attaches the scope to the
delegate's tool RPCs and host-core resolves the call under that mode instead of
the session's effective permission mode. With no declared scope — the default,
and the policy used by the builtins — no override is attached, so the delegate
inherits the parent's effective permission mode, including `auto` for explicit
external paths. A `project` definition's declared scope is dropped at parse
time with a warning, so opening an untrusted repository cannot escalate its
own delegates past the session mode. Two gates stay above any explicit scope,
exactly as they stay above the session mode: the contract modes' hard deny
(delegation only exists in Agent mode) and the external-path gate. An explicit
`accept-edits` still means "Write/Edit inside the workspace resolve without a
prompt; external paths and other tools keep their normal approval behavior";
an explicit scope remains an intentional override.

The surrounding contracts live in `03-tools-and-permissions.md` §10.2 (what a
delegate may call), `04-data-storage.md` §4.7a (persisted attribution),
`04-ux/03-permission-ux.md` §6a (more than one pending request) and
`04-ux/08-component-spec.md` §9.9 (how a delegation reads).

### 5f.2 No sibling or parent-to-parent channel (D326, ADR 0165)

Concurrent delegates do not message each other, and parent agents do not
message other conversations. The in-process `Peer` mailbox (ADR 0138 / ADR
0140) and the host-core A2A broker (ADR 0147 / ADR 0162 / ADR 0164) are
withdrawn.

Coordination stays on the existing delegation contract: the parent writes
independent briefs, starts `Task`s, and collects self-contained reports through
`TaskWait` / `TaskList` / `TaskStop`. A later round of work, if needed, is a
new `Task` whose brief includes earlier reports. `A2A` and `Peer` are not
assignable tools; a definition that names either is treated as an unknown
tool name and dropped with a parse warning.

## 6. Providers & models

> Full policy: `11-provider-model-system.md`, `12-provider-config-schema.md`, `13-model-catalog-and-selection.md`.

Coverage strategy:

1. **Native providers** exposed by pi-ai (OpenAI, Anthropic, Google, and others available at pin version)
2. **OpenAI-compatible** first-class path for gateways and long-tail vendors
3. **Custom providers** with protocol profiles
4. **Refreshable model catalog** + **free-form model IDs** (no closed allowlist)

MVP UI always includes at least:
- OpenAI
- Anthropic
- Google Gemini
- OpenAI-Compatible (generic)
- Custom provider entry

Runtime responsibilities:
- resolve `(providerId, modelId)`
- resolve and serialize the complete models.dev record, or label an absent ID
  with the unknown generic fallback
- resolve model reasoning capability and effective thinking level from the
  models.dev record
- fetch secrets via host (never cache raw secrets in logs)
- translate vendor failures into provider AppError codes
- stream tokens/events to orchestrator
- support abort/cancel mid-stream

Local models are supported through OpenAI-compatible endpoints (Ollama, LM Studio, vLLM, etc.).

### 6.1 One-shot Composer enhancement

Composer enhancement uses the same resolved provider binding and retry
classification as an agent request, but creates a separate completion context
with exactly one user message and the static enhancement system prompt. It
does not instantiate a session agent, include transcript history, expose tools,
or persist a turn. The renderer receives only the trimmed text result; API
keys and vendor refresh credentials remain in Electron main.


## 7. System prompt composition

```text
[base product prompt in English]
+ [operating-state prompt: agent/plan/goal]
+ [workspace info]
+ [tool instructions]
+ [project instruction chain, when present]
+ [optional user custom instructions]
```

The base prompt states collaboration rules explicitly, because omitting them
is what produced silent sessions: "prefer concise, actionable answers" was the
only relevant line, and a reasoning model executed it as saying nothing at all.
Required behaviours, each one an observed failure inverted:

- answer in the language the user writes in
- one sentence before each tool batch, and no silence longer than one tool
  batch or 60 seconds of work
- anything the user asked is answered in visible text; reasoning is not shown
  to them and does not count as an answer
- the final message is self-contained
- work is carried through end to end rather than stopping at analysis
- tool calls go through the native tool-call interface; a call written as prose
  (notably an OpenAI-style `multi_tool_use.parallel` wrapper) does not run, and
  the runtime logs it when a model emits one

It also states a search preference that matches the host-side budgets in
[16-tool-result-limits](16-tool-result-limits.md): scope `Read`, `Grep`, and
`Glob` with their own parameters instead of hand-rolling `cat`/`sed`/`grep`/
`find`. `Read` accepts only an existing regular text file. When a file name is
uncertain or a directory must be listed, an Agent activates `Glob` for the
current prompt through `ToolSearch` instead of guessing a name or reading the
directory. `Glob.path` is a directory, while `Grep.path` may be one file or a
directory tree. Calls use `Read.offset/limit`, `Glob.path/limit`, and
`Grep.path/include/outputMode/headLimit`; `filesWithMatches` or `count` avoids
unneeded content. Workspace-relative paths remain the portable default, with a
bounded command in the active shell only when native tools are insufficient.
Grep uses a system `rg` when one is installed and an in-process searcher
otherwise; the agent calls Grep rather than shelling out to `rg`. Bash must
still not assume `rg` is present. The agent must not repeat a search whose
answer is already in context.

The edit-discipline block carries the line-anchored `Edit` contract of
[18-line-anchored-edit-contract](18-line-anchored-edit-contract.md): the op
table, the `+`-only body rule, "ranges name changed lines only", "re-ground on
the tag returned by every successful write", and the worked anti-patterns. The
sidecar's `Edit` schema is `{ path, tag, ops }`; `old_string` and `new_string` no
longer exist, and the sidecar's tool description must stay byte-identical in
substance to host-core's `builtin_tool_defs()` entry, because a model taught one
grammar and validated against another fails every call.

### 7.1 Active tool context and on-demand loading (D185, ADR 0048)

The sidecar builds one complete tool registry, but it does not serialize every
registered schema into every provider request. Each new user prompt starts with
the mode's core set:

- Agent: `Read`, `Bash`, `Edit`, and `Write` (matching pi's coding-agent core)
- Agent: `Task`, `TaskWait`, `TaskList`, and `TaskStop` as well, whenever the
  subagent catalog is non-empty (§5f) — a capability the model has to go
  looking for is one it will not use, and the delegation lifecycle is worth
  the extra schemas per request
- Plan: `Read`, `Glob`, `Grep`, `BrowserPreview`, and `Bash`
- both modes: `ToolSearch` when at least one deferred capability exists

In Agent mode, `Glob` and `Grep` join `BrowserPreview`, plugin tools, `Skill`,
and plugin-development helpers in the deferred set. Both contract modes keep
their read/inspection core available, while the kind's submit tool
(`SubmitPlan` or `SubmitGoal`) is exposed only during the planning state, and
only for the active kind. Deferred tools are registered but their names and
compact
one-line descriptions appear in an `# On-demand tools` catalog; parameter
schemas do not. The catalog is bounded so a plugin with many tools cannot
recreate the original prompt bloat.
The model calls `ToolSearch` with an exact name or a short capability query.
The sidecar activates up to four matches, returns their names through
pi-agent-core's `addedToolNames`, and rebuilds the next-turn context with those
schemas. Providers with native deferred-tool search receive the definitions at
that load point; other providers receive the active definitions normally.

Deferred activation is reset before each new user prompt, so a previous task
cannot make an unrelated first request carry a growing tool set. The tool
registry, host permission path, tool timeout, and workspace containment rules
remain unchanged. `ToolSearch` is local to the sidecar and does not cross the
host RPC boundary. Its activation marker is retained in the persisted tool
result so a restored transcript remains provider-valid, although a restarted
runtime still requires a fresh search before reusing a deferred capability.

For user-visible HTML deliverables, the default system prompt asks the agent to
activate `BrowserPreview` once after creating the page or making its first
meaningful visual edit, using a workspace-relative path. The agent reuses the
live-reloading preview while iterating instead of issuing repeated preview
calls. Generated, test-only, and non-visual HTML files are excluded. When the
tool is deferred, `ToolSearch` must activate it before the preview call.
### 7.2 Plan prompt requirements

The Plan prompt tells the same Agent to understand the request, inspect the
relevant repository/specification/test context, identify impacted files and
risks, include focused validation and migration/recovery implications, surface
open questions. When any initial or revised plan is ready, it must call
`SubmitPlan` immediately exactly once in the current turn with one complete
Markdown snapshot. An accepted new Plan prompt has no prior pending approval;
earlier submissions in the transcript are historical immutable checkpoints.
After reject, expiry, or interruption, the Agent may revise in the new turn and
must follow the same one-SubmitPlan rule. It must not claim that changes were
made. The host writes the immutable `.pi/plan/*.md` artifact; the Agent does
not write or edit it itself and does not receive a request-changes flow.

The prompt may describe Bash as permission-gated and potentially mutating. It
must not describe Plan as a strict read-only security boundary.

### 7.2a Goal prompt requirements

The Goal prompt tells the same Agent to negotiate a goal contract before any
autonomous work. It asks for what to achieve rather than how: the outcome, the
acceptance criteria, and the boundaries. It must not enumerate implementation
steps, because the Agent decides those itself after approval. Every acceptance
criterion must be objectively checkable by the Agent after execution — a command
that must pass, or an observable behavior. The Agent inspects the workspace and
asks about anything ambiguous first, then calls `SubmitGoal` immediately exactly
once in the current turn with one complete Markdown snapshot.

The one-submit rule, the historical-checkpoint rule, the revise-after-close rule,
the no-chat-confirmation rule, and the host-writes-the-artifact rule are the same
as Plan's, with `SubmitGoal` and `.pi/goal/*.md` in place of their Plan
equivalents. The prompt additionally states that once approved, the contract is
the standard the Agent works against: it pursues the goal autonomously, chooses
its own approach, and stops only when every acceptance criterion is verified or a
boundary blocks it.

### 7.2b Subagent prompt composition (D201, ADR 0062)

A delegate's system prompt is composed in the sidecar from three parts, in this
order: the delegation framing, the definition's Markdown body, and the tool
guidance its declared tools earn. The body sits ahead of the workspace guidance
so a project's own instructions still have the last word.

The framing states the shape of the delegate's situation, which is not
inferable from the body: it is one delegated task, the delegate cannot see the
user, ask a question, or delegate further, it has exactly the listed tools, and
its final message is the only thing the main agent receives. A read-only
definition is additionally told never to report an edit it could not have made;
a write-capable one is told to touch only the files the task is about.

Guidance blocks are the same text the session prompt uses, included only when
the definition declares the matching tool: search/read scoping for
Read/Grep/Glob, edit discipline for Edit/Write, the command shell contract for
Bash, and the scratch-directory rule when the session has a scratch directory
and the delegate can write. The project instruction chain (§7.3) is appended
last, so a delegate follows the same project rules as its session.

### 7.3 Project instruction chain

The Electron main process first resolves the global
`~/.pi/agent/AGENTS.md`, then project instruction files inside the
session-bound project root when a runtime starts. For each project directory it
uses at most one non-empty file in this order: `AGENTS.override.md`, `AGENTS.md`,
`CLAUDE.md`, then `.claude/CLAUDE.md`. Entries are concatenated from project
root to the target directory, so the closest file appears last and takes
precedence. The initial chain targets the project root. Before a `Read`,
`Write`, `Edit`, or `BrowserPreview` call, the sidecar asks Electron main to
resolve the target path and replaces the active instruction section with that
path's complete chain before the tool executes. This keeps rules lazy and
prevents sibling-directory rules from persisting after the agent moves to a
different file tree.

The session-bound project root is passed with the runtime launch metadata and
registered by Electron main before each prompt or compaction request. The
sidecar cannot select a different root. During one prompt, path-resolution
claims are cached by project root and target directory, so repeated file tools
in the same directory do not perform another IPC request. Claims are discarded
at the next prompt, allowing edits and newly created instruction files to take
effect without a stale cross-message cache.

Path-specific resolution is best-effort and has a 2-second deadline. If the
resolver or its host RPC is unavailable or exceeds that deadline, the file
tool continues with the runtime's base/root chain rather than waiting for the
general host RPC timeout. A failed resolution never leaves a previously
resolved sibling-directory chain active.

All discovery stays within the session project root. Empty, unreadable, and
out-of-root files are skipped. The combined UTF-8 content is capped at 32 KiB
and source paths are labelled under `# Project instructions`.
The sidecar never reads workspace instructions directly. A changed root chain
recreates an idle runtime on its next prompt; nested instructions are resolved
again when a relevant file tool runs. The sidecar timing line records
`instructionResolveMs`, `instructionCacheHit`, and `instructionFallback`
separately from `hostRttMs` so a slow preflight cannot be mistaken for a slow
command body.

Settings provides dedicated management for the fixed global path. The Projects
view project-list menu provides an `AGENTS.md` editor for its corresponding
registered project root. Its IPC does not accept arbitrary renderer file paths.
Saves affect the next prompt without restarting the application.

## 8. Concurrency

| Scope | MVP policy |
|---|---|
| same session | single turn serial |
| different sessions | limited parallel |
| tools | sequential by default |
| `Task` calls in one assistant message | parallel; 10 running delegates per session (ADR 0089) |

Tool concurrency is expressed through pi execution modes: every catalog tool is
`sequential` and `Task` alone is `parallel`, and pi runs a batch sequentially as
soon as it contains one sequential tool. So an all-`Task` batch is the only batch
that fans out, and every other ordering guarantee is unchanged. Delegates issue
host calls independently, and host-core's one-mutation-per-session admission
keeps writes from tearing but leaves two same-path mutations unordered, so the
sidecar serializes `Write`/`Edit` calls that target the same normalized path
before they reach the host; calls on different paths never wait on each other.
This is what keeps the per-path edit-recovery rules of
`03-tools-and-permissions.md` §4d meaningful under fan-out.

Selecting another project tab affects only the visible shell workspace. It
does not dispose, abort, or re-root a runtime belonging to another session.

## 9. Abort semantics

- stop model stream
- attempt cancel interruptible tools
- do not auto-rollback completed writes
- mark turn aborted in UI/storage
- preserve elapsed response duration; when provider final usage is unavailable,
  estimate visible thinking plus answer output at four Unicode code points per
  token and persist it as `responseOutputTokens` so stopped-turn throughput is
  still available and visibly approximate
- renderer smart-stop transcript undo and structured Composer restoration are
  reconciliation after abort; they do not change runtime cancellation or roll
  back completed tool effects

## 10. Explicit non-goals

- no DOM knowledge
- no direct FS access bypassing Rust host
- no secret leakage into events/logs

## 11. Implementation status (M5)

Implemented: streaming turns over the OpenAI-compatible protocol path
(universal escape hatch, D024); one active turn per session enforced with
`AGENT_BUSY`; real `turnId` returned per accepted prompt; provider failures
mapped to `PROVIDER_UNAUTHORIZED` / `PROVIDER_RATE_LIMITED` /
`MODEL_NOT_CONFIGURED` / `STREAM_FAILED` / `TURN_ABORTED` where detectable.
The desktop development lifecycle rebuilds `packages/agent-runtime/dist`
before Electron starts so the spawned sidecar always executes the current
normalization and error-mapping source.

Tracked gaps (post-MVP backlog): richer system prompt composition (§7) and
provider/model catalog discovery beyond the currently wired paths.
