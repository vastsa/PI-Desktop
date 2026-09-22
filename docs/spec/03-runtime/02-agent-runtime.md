# 02. Agent Runtime

## 1. Goal

Applied decisions: **D002/D003/D008/D158/D189/D190/D193/D194/D278/D378**.


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
 steer(input: RuntimePrompt, expectedTurnId: string, message: UiMessage): { accepted: boolean; turnId: string }
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

### 4.0 Active-turn steering

`steer` validates the current turn identity before changing any state, then
queues user input through pi-agent-core's native steering queue in `all` mode.
The current provider request and any started tool batch finish first; all
accepted input is included at the next model-request boundary within the same
durable turn. A live provider request is not rewritten or aborted. Main owns
attachment validation and transcript persistence as for ordinary prompts.

Queued input retains its renderer message id when pi consumes it, including
when another input arrives before the initial user message has been consumed.
An admission after pi's last queue poll suppresses the terminal event and
continues once pi has released the run, with the same turn identity and without
a second public `agent_start`. Existing context/provider recovery takes
precedence over that continuation. Steering also wakes a parent that is idle
waiting for background delegates; it does not cancel those delegates.

Abort, graceful stop, fatal errors and terminal settlement close admission.
Accepted but unconsumed input remains transcript/context history and is removed
from pi's steering queue so it cannot execute independently on a later turn.
An ordinary follow-up stays in the separate Host-owned FIFO until durable turn
finalization. A steering failure must not terminate the active run.

### 4.1 Session title summarization

The renderer applies a short first-prompt fallback immediately so sending a
prompt never waits on title generation. After the first turn emits `agent_end`,
Electron main resolves the session's effective provider/model and invokes the
runtime's `summarizeSessionTitle` one-shot path with thinking disabled. The
runtime supplies the initial user prompt and an optional assistant reply,
returns only sanitized title text, and treats an empty/failing completion as a
non-fatal result. The renderer persists a successful title through the existing
`session.rename` path.

The renderer also persists a `manualTitle` marker in its local session metadata.
Automatic summarization is skipped for that marker and for any persisted title
that is neither a recognized default nor the deterministic first-prompt
fallback, which protects manual and already-summarized titles after restart.
No host RPC or storage schema change is required.

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
   the durable user message. Only an image that is within the 10 MB inline
   bound for a vision model is read into memory; larger images use streamed
   hashing/copying and the existing safe path fallback
7. snapshot the effective shell ID and dialect for the turn
8. start pi turn with the resolved session configuration and effective
   thinking level; HTTP 429 setup and stream failures use the runtime-owned
   silent ten-retry budget, while other transient transport/provider failures
   share a runtime-owned bounded ten-retry budget across the setup and stream
   phases (D127, D186, D245, D258, D378)
9. stream normalized answer and thinking events to UI
10. on tool calls, delegate to Rust host bridge with the durable `sessionId`;
    host resolves the session-bound workspace root
11. if pi finishes a message with `stopReason: "error"`, finalize any partial
    assistant bubble with a structured `UiMessage.error`, persist it in the
    transcript, and emit a normalized lifecycle `error` event carrying the
    same provider `AppError`; even a failure with no answer text remains a
    visible assistant error message
12. finalize and persist successful answer/thinking blocks independently

While an active turn has no new transcript row, the runtime emits a normalized
`status` event that names the quiet interval: `starting` for the prompt
handoff, `waiting-model` while a provider request waits for its first assistant
event, `preparing` after a tool batch and before the next request,
`compacting` during a context checkpoint, `recovering` during a silent-turn
re-run, `retrying` during a bounded provider backoff, and `waiting-subagents`
while the parent waits for delegated work (including each running target's
latest coarse child action). The renderer keeps the phase scoped to the session
and clears it when assistant or tool activity starts, or when the turn
terminates. This is observability only; it does not add a second agent loop or
a completion percentage.

The runtime constructs exactly one pi `Agent` per durable session. Plan does
not select a second model, planner service, permission implementation, or
runtime. The same Agent changes its planning state and tool registry after a
host-confirmed transition.

### 5d. Bounded provider recovery and diagnostics (D186, D245, D259, D378, ADR 0091, ADR 0128, ADR 0206)

Provider request setup and stream delivery are separate failure phases, but
HTTP 429 handling is one response-recovery policy. pi-ai's nested adapter retry is
disabled for this path so the runtime can share one budget across both phases.

`PROVIDER_RATE_LIMITED` receives at most ten retries after the initial
attempt, for eleven provider attempts total. A setup 429 is retried inside the
provider stream adapter. A mid-stream 429 removes the failed assistant from
the next model context and calls `continue()` in the same turn. Both phases
claim the same counter, so a setup 429 followed by a stream 429 cannot reset or
multiply the budget. The captured response status is applied before classifying
the provider message in both phases, so a generic 429 body still enters the
429 budget while known non-retryable classifications remain terminal. The main
session and builtin subagents use the same controller and policy.

429 retries are silent at the transcript lifecycle: no intermediate assistant
error, lifecycle `error`, `turn_end`, `agent_end`, or duplicate assistant
bubble reaches the UI. A normalized `status` event identifies the retry
backoff so the user can tell that the turn is still active. The visible
assistant message id is reused when a retry starts, replacing any partial
content in one bubble. End events are emitted once by the final successful or
exhausted attempt. An abort during the wait cancels the timer and prevents the
next provider request.

The delay follows the OpenCode-style order `retry-after-ms`, `retry-after`
seconds, `retry-after` HTTP-date, then exponential backoff. The fallback starts
at 2 seconds and grows exponentially with up to 25% positive jitter; every
server or calculated value is capped at 30 seconds. The runtime captures the
failed response status and headers from fetch because pi-ai's ordinary response
callback only covers an established response.

Non-429 transient failures share their own bounded response-recovery budget of ten
retries after the initial attempt, for eleven provider attempts total. The budget
is shared by request setup and stream delivery, so a fault that moves between
phases cannot reset or multiply it, and it is separate from the 429 budget. It
admits exactly `NETWORK_ERROR`, `TIMEOUT`, `STREAM_FAILED`, and retryable
`PROVIDER_ERROR` — including a gateway `502`/`503`/`504` that arrives before
headers or mid-stream. Authentication, model-selection, malformed-request,
context, and other non-retryable errors do not enter either provider replay
path, and a non-retryable `PROVIDER_ERROR` from a malformed 400/422 request
stays terminal.

Both budgets reset after a complete, non-error, non-aborted model response,
including a response that requests tools. The next model request starts with
fresh counters and backoff, even within the same user turn. Receiving HTTP
headers, partial text, or changing failure phase does not reset either budget.
This rule applies to the main session and builtin subagents: a long task with
independent recovered outages must not eventually stop because earlier tool
rounds consumed the budget. One-shot completions still use one bounded budget
for their single response. Persistent failures remain bounded and abortable.

Before surfacing a pre-stream `PROVIDER_ERROR` for HTTP 400/422 whose message
ends in `(no body)`, the runtime makes at most one silent repair attempt with
the generated output-limit fields removed: `max_tokens`,
`max_completion_tokens`, and `max_output_tokens`. This repair does not consume
the transient retry budget or add backoff, and the caller's `onPayload` rewrite
remains active. A second opaque failure is terminal, and an abort before the
repair starts prevents the repair request.

The non-429 delay honors the server first: `retry-after-ms`, `retry-after`
seconds, then `retry-after` HTTP-date, capped at 8 seconds. Captured headers are
retained for every status that can carry a usable delay (429, 408, 409, and
5xx), not for 429 alone. Without a usable header the wait is a plain doubling
schedule of 1, 2, 4, then remains at the 8-second cap for later retries. The
schedule is identical in the request and stream phases so a fault that moves
between them keeps one predictable rhythm. It is deterministic — no jitter —
because it paces one failed request rather than a synchronized rate-limit burst.
A server-stated delay wins outright, including one shorter than the scheduled
wait.

Only the failed request is replayed. The session, its transcript, and its tool
state are untouched: the failed assistant is removed from the next model context
and the same visible message id is reused, so a retry never restarts the turn or
re-runs a completed tool call.

The application setting `infiniteProviderRetry` is off by default. When enabled,
the main session and its builtin subagents skip only the ten-retry ceiling for
`NETWORK_ERROR`, `TIMEOUT`, `STREAM_FAILED`, retryable `PROVIDER_ERROR`
(including 5xx gateway failures), and `PROVIDER_RATE_LIMITED`. The same backoff,
`Retry-After` precedence, visible retry status, and abort/Stop path remain in
force. Non-retryable errors, context recovery, compaction, tool execution, and
one-shot completions are unchanged. The setting can keep billing requests alive
indefinitely until the user stops the turn.
Settings reads expose an explicit boolean for this flag: absent or disabled
values normalize to `false`. Read-modify-write operations on unrelated settings
must remain valid without enabling retries; non-boolean writes stay invalid.
Each retry is abortable and reports its current backoff through the normalized
status event. The `retrying` activity carries the classified error code, the
bounded/redacted provider message, and the HTTP status when known. The main
session, builtin subagents, and one-shot composer enhancement use the same
codes, budget size, and precedence.

When the retry budget is exhausted, the final assistant error and lifecycle
`error` are emitted once. Provider failures carry bounded diagnostics in
`AppError.details` when available: `phase` (`request` or `stream`),
`providerStatus`, `providerCode`, `providerWaitMs`, `streamMs`,
`retryAttempt`, the network diagnosis (`networkCategory`, `networkCode`,
`networkSyscall`, `networkHost`, `networkRoute`) and the request correlation
(`requestMessages`, `requestBytes`, `compactionGeneration`). For a persistent
429 or non-429 transient failure,
`retryAttempt` is `10`, derived from the exhausted error class's budget rather
than temporary retry activity state. Credentials and unrestricted response bodies never
enter the event or log. The active-turn status shows the remaining backoff and
the retry budget as `Retrying in 0s · attempt 9/10` in English.

Each retry builds a new request, stream, and `AbortController`; the one piece of
state a retry shares is the process-wide undici dispatcher. When the same origin
fails twice in a row without any response and no fresh attempt reaches it, the
transport is rebuilt once (throttled to one rebuild every 30 seconds, never for
`dns`) before the next attempt, so the retry does not replay into a pool whose
connection is already dead. The rebuild installs the replacement before closing
the previous dispatcher and closes it gracefully, and it reproduces the
configured route, so another session's in-flight request finishes on the pool it
started on and a proxy is never silently dropped.

### 5e. Silent-turn recovery

An ordinary turn that ends with no tool call and no visible assistant text is invisible
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
through one shared implementation of each half. The shared drain also handles
recoveries armed by a recovery attempt before it returns, so a chained failure
cannot leave lifecycle suppression active with no recovery or terminal event.
Skipping either half ends the run with its lifecycle still suppressed and no
recovery attempted, which reaches the user as a session that stopped mid-work
with no error and no retry action. §5d overflow and provider-stream retry ride
the same contract, and a suppression flag left behind would swallow the
*next* run's terminal events.

The one-shot instruction rides on the agent's system prompt rather than the
`prepareNextTurn` hook, because that hook only shapes turns inside a live run
and this run has already ended. It is removed afterwards unless a path-scoped
instruction reload rewrote the prompt meanwhile, in which case the newer
rebuild wins.

If the re-run is silent too, the turn ends as a visible assistant error with
retriable `EMPTY_MODEL_RESPONSE`, which gives the transcript its normal retry
action. No empty assistant message is persisted in either case.

A Host-ledger completion notice (ADR 0239, D446) is the narrow exception:
its prompt already permits no acknowledgement. Main resolves the queued message
by ID, verifies its target session, and constructs provenance from the ledger.
The runtime accepts silence only for `kind: completion` targeting the current
session with nonempty message and reply-to IDs. A silent notice reply emits its
normal completed message and terminal lifecycle without a recovery request or
`EMPTY_MODEL_RESPONSE`. Provider errors and aborts retain their normal handling,
and a provider retry of the same attempt keeps the exception. The original
task/result is not rewritten, and completion notices never request another
callback.

The exception covers exactly the notice's own reply: the first settled
assistant response of the run spends it, whether that response is silent,
textual, or a tool batch. A reply that follows tool results is therefore
ordinary work under this section, and the exception is revoked as soon as an
accepted steering message enters the model context, so a reply to the user
keeps its full re-run and error path. Every new run recomputes it from the
prompt's provenance. Ordinary user input, task/message deliveries, copied
source framing, and restored history cannot enable it.

An accepted silent reply is still not worth resending. Main persists it as an
empty completed row (the transcript hides it and the host stores no text), but
the runtime keeps it out of its entries and out of pi's transcript state, and
the context projection drops any assistant with no content blocks, exactly as
a restored transcript already did. The next provider request therefore carries
no empty assistant message.

Decision D193 and D446 (ADR 0239 amendment); see E2E-146 and
E2E-SESSION-completion-notice-allows-silence.

### 5e.1. Progress-only recovery for approved Plan/Goal execution

An approved Plan or Goal can still stop after a visible progress update when
the model puts its narration in a text-only assistant message and emits the
tool call in a later message. Ordinary Agent prompts do not use this recovery.
The runtime only arms it for a successful, non-aborted message with no tool
call whose visible text has a clear forward-looking action signal such as
"Writing the remaining note" or "the next step is ...". A normal completion
report such as "Implemented the approved plan" is terminal and is not nudged.

The recovery is bounded to one attempt per approved execution. The progress
text remains in the current assistant bubble, while its assistant message is
removed from model context before `continue()` so the provider never receives
an invalid assistant-to-assistant transcript. The first attempt's
`agent_start`, `turn_start`, `turn_end`, and `agent_end` are suppressed; the
continuation reuses the same bubble id and emits the single terminal lifecycle.
The progress nudge is attached to the system prompt for that continuation and
removed afterwards. If the continuation produces a tool call, the normal
autonomous loop proceeds; if it produces another text-only response, that
response is terminal and cannot trigger a second progress nudge. A silent
recovery that already ran in the same execution also prevents the recovered
final report from being misclassified as progress.

See E2E-146a.

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
   input against the model window, reduces it once, and then splits a range that
   still does not fit into chunks that each do, so a prompt too large for one
   request is summarized by several (ADR 0302). An automatic summary failure
   first attempts a deterministic retained-tail checkpoint, while manual
   compaction still reports `CONTEXT_COMPACTION_FAILED`
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

**What survives a checkpoint.** A successful checkpoint leaves the model context
as the summary plus, at most, one **user** message; assistant and tool messages
are dropped from model context and remain in the visible transcript. pi's
`prepareCompaction` still chooses the cut point, so its turn-boundary and
split-turn handling are preserved, but the runtime then folds the split-turn
prefix and the recent tail back into the summary input, so the summary covers
the whole compacted range and nothing crosses the boundary uncovered.

A **retained-tail fallback** is the exception, because no summary covers its
range: it keeps the real recent window — the newest contiguous messages of the
compacted range, every role, bounded by the keep-recent target and by what the
safe budget leaves once the carried-forward summary and the recovery notice are
paid for — and records `details.retainedTailShape` as `recent_window`, so a
rebuild replays that window instead of narrowing it back to one user message
(ADR 0302, issue #827). It drops the assistant messages pi drops from the
rebuilt context anyway (error, aborted, deferred) and any tool result whose tool
call is not in the window, because a provider rejects a result whose call is
missing. An `active_turn` fallback also keeps the active task's user message
ahead of the window when the window itself cannot hold it, so the continuation
never loses its goal.

The retention mode is selected from the lifecycle that requested compaction. It
decides what a *successful* checkpoint leaves behind:

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
- A retained-tail fallback carries its recent window in both modes, because the
  alternative is an empty context; the mode still decides whether it has to
  keep the active task's user message as well.
- The `fresh_window` family remains the deliberate no-summary exception from
  ADR 0064 and always carries an empty tail.

The retained-tail mode and shape are stored in the checkpoint's opaque `details`
field, so a restart preserves the same task boundary and the same treatment of
the tail. A checkpoint without the shape marker — every successful checkpoint,
and every record written before the marker existed — is normalized to its latest
user message only, so a restart cannot restore a sequence of
executable-looking old requests. Dropping an assistant message also drops its
tool calls, and the fallback drops the results of calls it did not keep, so no
orphaned tool call or unmatched result can reach the provider. The retained tail
is re-estimated with the summary before persistence and before continuation, so
an oversized request still cannot pass the guard. A fallback also records
`details.failureReason` — `no_new_history`, `summary_budget`,
`summary_provider`, or `checkpoint_oversized` — a closed vocabulary rather than
provider error text, which can carry endpoint details.

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
window and leave the summary no room. A fallback's window is capped by 25% of
the hard budget and by the room the carried-forward summary and the recovery
notice leave, so recovery cannot install a checkpoint the guard rejects. None of
these values are configurable.

**Estimate calibration (D606).** Every threshold above is compared against one
number, and that number is corrected against what requests actually cost. pi's
`estimateContextTokens` anchors on the last assistant usage and estimates
everything after it as `chars / 4`: that constant under-counts CJK text, and
with no anchor left it omits the system prompt and the tool schemas, which the
next request still pays for. The two errors are measured and applied
separately — the per-character bias as a scale-free ratio over the guessed
tail, and an unanchored residual as a ratio only for observations taken at a
comparable scale (0.5×–2× of the estimate), otherwise as the observed overhead
capped at 32,000 tokens.

The correction is asymmetric because this number gates compaction: upward
applies once three observations exist, downward needs three agreeing samples,
is capped at 15 % per step and can never take the value below 85 % of the raw
estimate, so a projection at 1.18× the hard limit (`1 / 0.85`) still compacts.
A report outside 0.5×–3× of what the calibration predicted is treated as a
misreport, and two consecutive misreports freeze the downward direction until a
usable report arrives.


The provider request layer also caps the concrete output budget before every
parent, subagent, and one-shot request. It estimates the serialized input with
the pi-ai chars/4 baseline plus a CJK correction, then reserves the larger of
4,096 tokens or 1% of the effective window. The effective window is the smaller
of the configured value and the published catalog window when both are known;
this prevents an oversized user override from bypassing compaction and output
protection. Unknown windows preserve the configured output budget.

The incoming user prompt participates in budgeting before the first provider
request. The automatic summary request retries transient provider failures
under a bounded pi-ai retry policy (3 retries, 2s/4s/8s backoff, cancelled by
Stop); deterministic failures such as quota or auth return at once. The
preflight guard sizes the prompt pi actually serializes — tool results already
capped — rather than the raw messages, and when that prompt still exceeds the
window it tries exactly one reduced input (tool results cut to a short prefix,
thinking dropped, no message removed). If even that input does not fit, the range
is split into contiguous chunks that each do: at most 16 requests, each carrying
the previous chunk's summary through pi's update-the-summary prompt, with the
range's file list appended on the last one, and the checkpoint reports the summed
usage of the requests that produced it. A budget therefore decides how many
requests a summary takes, not whether the model is asked at all (ADR 0302); only
an empty range, or one past that request bound, still gives up on the summary
(ADR 0282). If normal compaction still fails during an automatic threshold or
overflow recovery, the runtime persists a short recovery checkpoint with the
previous summary (when available) and the bounded recent window described above.
The complete transcript remains durable and visible, while the next model
request receives only that recovery checkpoint and applicable tail. The
lifecycle event marks this as `fallback: "retained_tail"`, and the checkpoint's
mark carries the same `fallback`, so the renderer shows a warning and labels
the transcript row as a failed summary rather than a false success. If the
fallback cannot be prepared, persisted, or kept below the safe budget, the user
row and an assistant error remain durable and no provider request starts.
Provider-reported context overflow is the last recovery layer: omit the failed
assistant from model context, compact once, and retry once. A second overflow
remains terminal. Bedrock's `prompt is too long: N tokens > M maximum` form
maps to this path.

Automatic protection is always enabled and is not user-configurable. The
runtime still accepts a construction-time override that disables it, used by
tests; persisted `contextCompaction` settings are ignored so a session cannot
be left with the guard off and no way to restore it. Manual `/compact` remains
available while the session is idle. Checkpoint generation is abortable and
counts as running state until durable persistence completes.

A delegate (§5f) runs the same derivation against its own resolved model and
compacts at its own turn boundaries, without a durable checkpoint chain of
its own (ADR 0299).

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
  when the next prompt starts under the new mode. The Composer mode chip
  pulse and the compact transcript Planning row are that same live
  projection: the chip label may already show the staged mode, but it does
  not pulse until the in-flight turn projects `planning`.

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
while idle or when the Agent calls `enter_plan_mode`. In Plan, the Agent can
inspect, use context controls, run Bash through the selected permission mode,
and call `submit_plan(title, markdown, question)`. Host-core preserves the
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
is a new turn: earlier `submit_plan` calls remain historical immutable
checkpoints, and the Agent must call `submit_plan`
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
while idle or by the Agent calling `enter_goal_mode`. Goal has the identical tool
surface as Plan, except that its submit tool is
`submit_goal(title, markdown, question)` and its artifact is written to
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
  and `max`. Session (and subagent) selectors also accept `omit`, which is
  not a catalog/binding capability: the runtime keeps agent bookkeeping at
  `off` and uses the low-level provider stream so no thinking override is
  synthesized (ADR 0194 / ADR 0295).
- The bundled models.dev release snapshot is authoritative for published
  reasoning support, thinking-level mapping, limits, input/output modalities,
  pricing, and other model metadata. pi-ai remains responsible for request
  serialization and adapter compatibility.
- Provider configuration cannot override published reasoning, thinking,
  limits, or other model metadata. The explicit attachment capability fields
  are the exception: `supportsImages` and `supportsDocuments` are effective
  binding overrides for the endpoint.
- Unsupported requested levels use the selected models.dev model's
  nearest-supported-level rule: scan upward first, then downward. A
  non-reasoning provider always resolves to `off`.
- Vision support starts from the same published model record. An absent or
  `null` `supportsImages` follows its image input; `true` or `false` explicitly
  enables or disables image transport for the configured binding. Unknown or
  custom ids remain conservative text/path models unless their binding
  explicitly enables image input.
- The effective level is passed to the pi `Agent`; provider-specific request
  serialization remains pi-ai's responsibility.
- Pi `thinking` blocks become `UiMessage.thinking` and
  `message_update.deltaThinking`. They never append to `content` or
  `deltaText`.
- Append-only `message_update` events set `stream: \"delta\"` and carry only the
  new chunk. The runtime keeps the full `currentAssistant` in memory, coalesces
  deltas every 16ms, and flushes before tool/terminal/abort/error/retry
  boundaries. `message_end` is the authoritative snapshot (D412).
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
  attachment, scratch, and project roots. Images within the 10 MB inline
  safety bound become transient pi-ai image blocks; oversized or unavailable
  images become safe `@path` fallbacks. Oversized history hydration copies
  files without first loading their contents into memory. Base64 is never
  restored into durable UI messages or transcript records.
- Failed assistant messages remain durable diagnostic transcript entries but
  are never restored into pi model context on a later turn.
- A tool-call id is unique in every request. The transcript is an append-only
  snapshot stream that tolerates a retried append, so the same call can reach
  the assembled context twice — under one row id, which the host's keep-last
  read already collapses, or under two, which it cannot. The last view before
  the wire therefore keeps the first occurrence of each `toolCall` id and drops
  a later call or a later result for it, so the pair the provider validates
  stays well-formed; a request with no duplicates is returned unchanged. A drop
  is reported once on the `agent` log channel with the session and the ids
  (D608). Anthropic-family endpoints, including DeepSeek's, reject the whole
  turn with `tool_use ids must be unique` (issue #718), which leaves the session
  unable to continue.
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

**Catalog.** Definitions are Markdown documents from two sources: the five
builtins shipped inline in `agent-runtime` (`explorer`, `code-reviewer`,
`test-runner`, `fixer`, `ui-designer`) and the global user documents under
`~/.agents/subagents/*.md`. There is no project-level subagent directory and
`.pi/agents` is not scanned for capabilities. User documents are filtered by
the app-local enabled state before they reach the loader, and the shipped
builtins are filtered by that same app-local state inside it (ADR 0270).
Electron main loads
`subagentProviders` in the sidecar params, so editing a definition takes effect
on the next prompt. The catalog is capped at `MAX_SUBAGENT_DEFINITIONS` (16);
a malformed or unreadable document becomes a launch diagnostic and never fails
the launch.

Frontmatter adds `permission: inherit | ask | accept-edits | auto` (default
`inherit`), which controls the scope the delegate's tool calls resolve under
instead of the session mode (§5f.1). `tools: inherit` (alone or with assignable
extras) opts a definition into the parent session's live tool catalog minus a
deny list (ADR 0246 / D415); builtins stay on today's whitelist. `idle-timeout`
and `max-duration` still parse for compatibility but no longer kill a run
(D328). Only builtin and user definitions may declare a permission scope —
both express a choice the user already made, whereas a project definition
arrives with the repository, so honoring its scope would let cloned code grant
itself `auto`. A project document that declares a non-`inherit` scope keeps
loading with a warning and its delegates run under the session's effective
mode; a user who wants the scope copies the document into their own agents
directory. Builtins, including the write-capable `fixer` and `ui-designer`, do
not override the parent session by default: they follow `auto` completely
(including explicit external paths) while `ask` and `accept-edits` retain
their normal approval behavior. An explicit builtin or user scope remains an
intentional override.

**Tools (ADR 0089).** Delegation is a four-tool lifecycle, built only in Agent
mode and only when the catalog is non-empty, and all four belong to the Agent
core set rather than the on-demand catalog of §7.1:

- `task(agent, task, description?, model?, resume?)` — validates its arguments (an
  unknown `agent`, an empty `task`, an unresolvable model pin and a definition
  whose tools are all unavailable each return a tool error explaining the
  failure rather than throwing), starts the delegate **in the background**, and
  returns immediately with a `delegationId`. Starting fails with a tool error
  when the session already runs `MAX_SUBAGENT_CONCURRENCY` (10) delegates.

  The `task` tool accepts an optional `model` parameter
  (`"provider/modelId"`) that overrides the delegate's model for that run.
  Resolution priority: Task.model parameter → definition frontmatter pin →
  session model. The parent agent sees a model summary in the system prompt
  listing all models marked `availableForSubagents` in provider settings. If
  the delegation catalog is empty, the prompt tells the model to omit `model`
  and use the definition pin, or inherit the session model when unpinned; an
  explicit key that exactly names the current session provider/model is treated as the same inheritance case. Other
  explicit model keys must be configured and enabled for delegation. Electron
  sends `subagentModelKeys` separately from `subagentProviders`: the latter may
  include definition-only pins, while only the former authorizes cached
  overrides and the model summary. Missing keys default to an empty list;
  successful on-demand resolution is cached separately from launch opt-in and
  does not rewrite definition pins or runtime reuse matching. On-demand
  provider matching uses the same unique id/vendor/name rule as pin resolution.
  A changed opt-in list retires the idle runtime on the next launch. Pins remain usable
  by their own definitions when `model` is omitted or when `task.model` repeats
  that definition's own pin key, even without an opt-in.
  The Task definition catalog displays each default model and treats omitting
  or repeating that key as keeping the default. See
  [ADR subagent-model-opt-in](../../adr/subagent-model-opt-in.md).
  When a model key is not pre-resolved, the runtime asks Electron main to resolve it
  on-demand via the `provider.resolveSubagentModel` RPC. The started `task`
  result details record the effective `modelId` and resolved `thinkingLevel`
  used for that run. The level is resolved after inheritance and target-model
  capability clamping; `omit` records that no provider thinking override was
  sent.
- `task_wait(delegationIds?, mode?, minCompleted?, timeoutSeconds?)` — converges
  on running delegations (defaults to all of them) and returns their reports;
  `mode: "any"` with `minCompleted` converges as soon as the first N settle.
  Settled delegations return immediately, so re-reading a report by id is
  cheap. The joined result is bounded to `MAX_TASKWAIT_RESULT_CHARS` (50k); if
  the bound omits finished reports, those reports remain undelivered and the
  runtime sends them on the idle resume (or they can be re-read by id).
  `timeoutSeconds` defaults to 600 and is clamped to 900: the wait blocks the
  turn, so the ceiling is what bounds how long a session can look hung. Expiry
  is not a failure and does not stop the delegates (D328) — the wait returns a
  heartbeat (agent, status, elapsed, turns, last tool) plus any finished
  reports. The runtime keeps the parent turn open and delivers remaining
  reports when they finish, even if the parent already stopped calling tools.
  Only `task_stop` or user Stop aborts a delegate.
- `task_list()` — reports every delegation of the session with status and a
  running heartbeat.
- `task_stop(delegationIds?)` — stops running delegations (defaults to all);
  waits for each abort to settle, then persists `status: "stopped"` with
  `completedAt` on `details.stopped[]`. Stopped delegations read as `stopped`.

**Live settlement.** When a delegate settles, the runtime refreshes its original
`task` transcript row with the terminal delegation summary (`status`,
`completedAt`, counters, and failure details when present), using the existing
full `message_end` snapshot. This does not depend on the parent calling
`task_wait` / `task_list` / `task_stop` or on other delegates finishing. The
snapshot retains the Task call's identity, arguments, tool timing, and token
usage; it does not execute the tool again or add usage to the parent turn.
The initial Task result is emitted first even if the delegate settles before
that result arrives. Electron persists the refreshed row through the normal
message outbox so session switching and history reload preserve the outcome.
An outbox write acknowledges only the snapshot sent to the host; a newer
snapshot replacing the same message ID during that write remains queued.
No new event type or storage schema is required.

**Delegate loop.** A `SubagentRun` is a second pi `Agent` in the same sidecar
process with the definition's system prompt, its (possibly pinned)
provider/model, its declared tools, and the same host connection. A pinned or
explicitly selected delegation model uses the exact provider/model binding
saved in Settings for its effective thinking capability; models.dev supplies
the baseline only. It runs under
the same bounded provider retry policy as the parent. A delegate has no turn
limit: it ends when it finishes, when the parent calls `task_stop`, when the user
Stops, or when a terminal parent error aborts it (ADR 0253). A document that
still declares `maxTurns` loads normally and the key is ignored like any other
unrecognized frontmatter key. `maxTokens` is an optional per-definition
output cap (maximum 200000); omitted, `none`, or `0` follows the model's
published limit. It overrides `maxTokens` on the model built for that delegate,
so the adapter's derived `max_tokens` / `max_completion_tokens` /
`max_output_tokens` carry it, and it binds that delegate's own responses only —
the session's requests keep the model binding. A value past the ceiling is a
typo and is clamped rather than forwarded to the provider.
The built-in `explorer` declares `read`,
`glob`, `grep`, and `bash`, while `code-reviewer` remains read-only;
`fixer` and `ui-designer` write inside the workspace, and `ui-designer` adds
`browser_preview` so it can open and inspect its rendered result before reporting.
`browser_preview` only opens a live-reloading workspace HTML page; responsive,
keyboard-focus, and reduced-motion checks require project-provided browser
tests or other tooling. Its statuses are `completed`, `failed`,
`aborted`, `timed_out` and the registry-only `stopped`;
the terminal ones surface through `task_wait`, whose text is
the report (bounded to `MAX_SUBAGENT_REPORT_CHARS`, 12k) and whose details
carry `delegationId`, `agent`, `modelId`, `thinkingLevel`, `status`, `startedAt`,
`completedAt` when settled, `turns`, `toolCalls` and, on failure or timeout,
`error`. The same effective model and thinking fields are included in the
immediate `task` result and in lifecycle snapshots so live and restored
delegation views do not re-derive them from definitions or parent settings.
`startedAt` and `completedAt` are runtime timestamps in milliseconds and are the source of
truth for renderer delegation duration; the immediate `task` tool-call
duration only covers starting the background work.

**Delegate lifetime (D328).** The runtime does not idle-timeout or
duration-timeout a delegate. `idle-timeout` / `max-duration` frontmatter still
parses so old documents load, but those values are not armed. A delegate runs
until it finishes, fails, is `task_stop`'d, or the user Stops / the runtime is
disposed. The parent agent judges whether to
cancel via `task_stop`; a one-line heartbeat (who, status, elapsed, turns, last
tool) is what it has to go on while the delegate is running.

When the parent stops calling tools while delegates are still running, the
runtime swallows that `agent_end`, keeps the durable turn open, waits for the
delegates, and prompts the parent with their reports. Ending the parent loop
does not abort them.

Fatal provider/stream errors (including exhausted HTTP 429) and parent aborts
retain their existing `failed` and `aborted` outcomes. A terminal parent error
also aborts leftover delegates,
skips the resume prompt, and returns the session to idle so Continue is not
`AGENT_BUSY` (D352).

**Resumable delegations (ADR 0279).** `task` accepts an optional `resume`
parameter carrying the `delegationId` of a settled delegation in the same
conversation. The resumed delegate is a new `SubagentRun` seeded with the
chain's prior messages — the original `task` brief plus every row the chain
produced — and then prompted with the new `task`, so a delegate that already
read or changed a file continues from that context instead of starting cold.
Seeding is transcript-backed: the chain's rows are exactly those carrying
`parentToolCallId` for one of the chain's `task` calls, and they are converted
into provider messages with the delegate's own binding (a pinned delegation
model is not the session model). Nothing is kept warm in memory and no new
event type, storage schema, or tool parameter is introduced.

A chain is the sequence of `task` calls that share one delegate session: the
first call, plus every later call that passed the earlier `delegationId` as
`resume`. The runtime rebuilds the chain index from the persisted transcript at
launch — each `task` row carries its own `delegationId` and settled status in
`toolResult.details` and the resumed id in `toolArgs.resume`, with the agent
name normalized on rebuild — so resumability survives a sidecar restart.
Chain identity (`delegateSessionId`) stays internal; the parent only
ever passes a `delegationId`, and the reverse map resolves it.

Only `completed` and `failed` chains are resumable; `stopped` and `aborted` runs
are terminal and revive only by starting a new delegation, and a run the app
closed while it still worked rebuilds as `interrupted`, which is not resumable
either. A chain whose read-only tool output exceeds `MAX_RESUMABLE_READ_LINES`
(50000) leaves the reusable list without an in-chain trim, so a resume never
silently drops history. The registry keeps at most
`MAX_RESUMABLE_CHAINS_PER_AGENT` (2) reusable chains per definition name and
evicts least-recently-active ones whenever a delegation settles; a chain that is
still working is never evicted, so the bound counts reusable chains and a live
chain may sit above it until it settles.

Resume is strictly same-session and never queues: resuming a running
delegation is a tool error telling the parent to converge with `task_wait`
first, and a chain has at most one live record at a time. `model` and `resume`
together are rejected, and a resumed run keeps the chain's recorded binding:
the `providerId/modelId` key it resolved is preferred, a chain rebuilt from the
transcript is matched by model id, and when nothing resolves it the run
continues on the definition's current binding and records the previous model id
as `modelChangedFrom` in its lifecycle details. Changing models on purpose means
starting a new delegation. An unknown id, an id belonging to another definition,
a non-resumable status, an over-budget chain, and a chain whose rows are gone
each return a tool error naming the reason and, for an unknown id, the reusable
ids when there are any.

The parent discovers reusable chains through the system prompt, which lists
each chain's latest `delegationId`, its objective, and up to
`MAX_RESUMABLE_LISTED_FILES` (8) of the files it read (with a `(+N more)`
suffix past that). The list is recomposed when a delegation settles, around the
existing prompt sections. A resumed run is an ordinary delegation for
`MAX_SUBAGENT_CONCURRENCY`, `task_wait`, `task_list`, `task_stop`, and lifecycle
snapshots. The immediate `task` result and the lifecycle details add
`resumedFrom` for audit; the transcript renders a chain as one continuous
multi-turn conversation under its latest `task` card, with no separate
"resumed" marker.

**Model pins.** `model: <provider>/<model>` in the frontmatter is resolved once
per launch in Electron main, where credentials and the models.dev snapshot live, against
provider id, vendor key or display name, and capped at
`MAX_SUBAGENT_PROVIDERS` (8) distinct providers. An unresolvable pin is omitted
from the binding map on purpose; the runtime turns the missing entry into a tool
error naming the pin, and never falls back to the session model. A definition's
`thinkingLevel` is clamped against the resolved model with the same
nearest-supported rule as §5c, except that the special `omit` value deliberately
sends no thinking override and leaves the provider adapter's own default in
control.
`agents.create` and `agents.update` accept the pin only in that
`<provider>/<model>` shape; a value without a provider half is rejected with
`SUBAGENT_INVALID` rather than written, because the runtime could never resolve
it. Only the slash is structural — the provider half is matched by a normalized
alias, so a display name containing spaces is valid.


**Ordered model fallback.** A definition may declare `fallbackModels` as an
inline list (`fallbackModels: [provider/model, other/model]`) or a block list.
The managed host `agents.create` / `agents.update` inputs and records expose
`fallbackModels?: string[]`; omission preserves a list on update and `[]`
clears it. Existing `model` pins and Task override priority remain unchanged.
A missing primary pin still fails before launch. Alternatives are resolved in
Electron with the definition pins and count toward the existing eight-provider
ceiling. They authorize only that definition, including when Task overrides
its primary, and do not enter the independent `task.model` opt-in catalog.

After a provider failure exhausts that model's retries, or is non-retryable,
the same child Agent advances through these alternatives in order. Actual
provider-id/model-id duplicates are skipped; an unresolved alternative is
reported and skipped. The runtime removes only the terminal failed assistant
from model context, preserving the original user task and completed tools,
then continues with the next provider's adapter, credentials, request headers,
output cap, and re-clamped original thinking selection. `omit` stays omitted.
The completed tool history is never replayed by the fallback controller.
Host/tool failures, unexpected thrown errors, no-report outcomes, and Stop do
not trigger fallback. The run's original owner and abort signal govern every
attempt, and usage/counters include all attempts. No configured alternatives
means the existing single-model behavior.

Failure diagnostics remain in the child transcript, bounded parent report,
and additive `modelFailures` lifecycle detail. Lifecycle model/thinking fields
track the effective alternative, including after settlement and reload. If all
alternatives fail, the result remains `failed` with the final provider error.
See [ADR subagent-model-fallback](../../adr/subagent-model-fallback.md).

**Context budget and compaction (ADR 0299).** A delegate has the same
window protection the session has, derived the same way. The budget comes
from the model the run actually resolved — a `task.model` override, a
definition pin, or the inherited session model — through the shared
derivation of §5.1, so `hardLimit` is that window minus the same request
headroom and a per-definition `maxTokens` cap participates as the output
budget. At a delegate turn boundary the run re-estimates its own context and,
at or above `hardLimit`, compacts synchronously before the next provider
request, with the retention mode chosen from the same lifecycle rule as the
session: a boundary that still has pending tool results retains as an active
turn, a completed one as a completed turn. There is no pre-computation and no
second threshold.

When a summary cannot be generated, or the compacted context still exceeds
the budget, the run degrades: it keeps the original task brief plus the most
recent message(s), discards the rest of its history, continues, and records
that it was degraded, so the report and the lifecycle details say the
delegate lost history rather than presenting a complete answer. When even
that does not fit, the run fails with `SUBAGENT_CONTEXT_OVERFLOW`
(not retriable) naming what the parent can change — narrow the task,
delegate to a model with a larger window, read less at once — instead of
forwarding the provider's overflow text.

An ordered alternative (**Ordered model fallback**, above) is re-evaluated
against its own window before it is attempted: an alternative whose budget
cannot hold the carried context is skipped and recorded in `modelFailures`
with that reason rather than retried into the same failure. A resumed chain
is seeded within the budget — `seedDelegateMessages` preserves the original
task brief and the recent turns and drops the oldest tool results first — so
a resume starts below `hardLimit` instead of overflowing on its first
request.

Delegate compaction affects the delegate's model context only. It rewrites no
persisted transcript row, writes no host-core checkpoint, and adds no
compaction row, warning toast, or context-inspector line; the delegate keeps
its complete visible rows and the parent still sees only reports. Compaction
is entirely automatic: `new_context` remains denied to delegates, because
executing it would set the parent runtime's pending-compaction flag.

**Events and context.** Every event a delegate emits carries
`parentToolCallId` and `agentName` on its envelope, and Electron main copies both
onto the persisted row. When the runtime rebuilds model context it skips every
row with `parentToolCallId`: the parent only ever saw reports through
`task_wait` or the runtime's completion prompt (D328), and replaying delegate
rows would both contradict that and reintroduce the context cost delegation
exists to avoid.

**Turn ownership.** A delegate's lifecycle never reaches Electron main's turn
handling. The parent may keep working or talk to the user after `task`. If it
stops calling tools while delegates still run, the runtime keeps the durable
turn open and delivers the reports when they finish. User Stop, `task_stop`,
runtime dispose, or a parent fatal error (D352) abort a still-running
delegate.

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
`accept-edits` still means "write/edit inside the workspace resolve without a
prompt; external paths and other tools keep their normal approval behavior";
an explicit scope remains an intentional override.

The surrounding contracts live in `03-tools-and-permissions.md` §10.2 (what a
delegate may call), `04-data-storage.md` §4.7a (persisted attribution),
`04-ux/03-permission-ux.md` §6a (more than one pending request) and
`04-ux/08-component-spec.md` §9.9 (how a delegation reads).

### 5f.2 No in-process sibling or parent-to-parent Task channel (D326, ADR 0165)

Concurrent `task` delegates do not message each other, and the parent Task
runtime does not address other conversations. The in-process `Peer` mailbox
(ADR 0138 / ADR 0140) and the host-core A2A broker (ADR 0147 / ADR 0162 /
ADR 0164) are withdrawn.

Coordination stays on the existing delegation contract: the parent writes
independent briefs, starts `task`s, and collects self-contained reports through
`task_wait` / `task_list` / `task_stop`. A later round of work, if needed, is a
new `task` whose brief includes earlier reports. `A2A` and `Peer` are not
assignable tools; a definition that names either is treated as an unknown
tool name and dropped with a parse warning.

### 5f.3 Plugin-mediated session collaboration (D409, ADR 0239)

The official `pi.session-orchestrator` plugin is the reviewed exception for
durable cross-session communication. Its `desktop.control` calls are composed
outside the `task` runtime and are admitted only from the plugin's active
Agent tool invocation. Host-core owns the source/target Session IDs, durable
delivery ledger, permission ceiling, actual target turn, completion callback,
cancellation, restart fence, and transcript provenance. Existing sessions keep
their own project, model, context, and permission configuration; a newly
spawned worker inherits the initiating session's project and permission
ceiling.

Session messages are framed as agent-provided task data and never become new
human authorization. A completion callback is durable and at-most-once, and
does not automatically trigger another callback. This path does not restore
the withdrawn `A2A` or `Peer` tools and does not change `task`, `task_wait`,
`task_list`, or `task_stop` semantics.

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
keys and vendor refresh credentials remain in Electron main. OpenCode Go
one-shots reuse the conversation id as `x-opencode-session` when a session is
present; otherwise the runtime synthesizes a per-call id so the gateway
accepts the request.

### 6.2 OpenCode session routing headers

Chat, subagent, context-compaction summary, prompt-enhancement, and plugin
one-shot completions whose provider is `apiStyle: opencode_go`, whose
`vendorKey` is `opencode` or `opencode-go`, whose pi-ai provider id is one of
those values, or whose base URL host is `opencode.ai` send:

- `x-opencode-session`: the durable conversation id, or a per-call UUID when
  the caller has no session
- `x-opencode-client: pi-desktop`
- `User-Agent: pi-desktop/<APP_VERSION>`

Caller-supplied headers override the client and User-Agent defaults. An empty
session header is restored from the conversation id so OpenCode Go cannot
return `MissingSessionID`. A provider-row `headers` map is applied after this
merge (headers plus a fetch wrapper) so custom values win over the OpenCode
default and over adapter last-writes. Reserved keys cannot smash
`x-opencode-session`. This is an agent-runtime concern, matching the
official Pi coding-agent attribution layer; pi-ai's `sessionId` stream option
does not emit `x-opencode-session`.

The context-compaction summary is a provider request of the same kind, but the
harness assembles its own stream options and never passes the session's stream
function, so agent-runtime applies the header merge to the model collection it
hands to compaction. That request carries the session's conversation id rather
than the per-call id the harness would otherwise mint, so a summary reaches the
same gateway backend as the conversation it summarizes.


## 7. System prompt composition

```text
[base product prompt in English]
+ [operating-state prompt: agent/plan/goal]
+ [workspace info]
+ [tool instructions]
+ [project instruction chain, when present]
+ [optional user custom instructions]
```

### 7.0.1 User custom system prompt files (issue #542)

The `[optional user custom instructions]` layer is the pi-compatible file pair
`SYSTEM.md` / `APPEND_SYSTEM.md`, discovered per session launch from
`<workspace>/.pi/` (project) and `~/.pi/agent/` (global), each kind picking a
single winner with project over global, exactly like pi CLI. A change to the
resolved content retires the runtime through the reuse match, so the next
prompt recomposes; the files are not re-read per tool call like the project
instruction chain. Native-pi sessions keep resolving them through the upstream
`DefaultResourceLoader` as before.

Two deliberate deviations from pi CLI's semantics:

- `SYSTEM.md` replaces only the base product persona line, not the whole
  prompt: the operational rules below (collaboration, search, edit contract,
  scratch, delegation, skills) are desktop mechanics a persona file must not
  remove.
- `APPEND_SYSTEM.md` is appended after the composed base prompt and before
  the project instruction chain, matching pi's ordering, so the user's own
  `AGENTS.md` keeps the last word.

Both files are capped at 64 KiB, and a whitespace-only file counts as absent.
Native `SYSTEM.md` / `APPEND_SYSTEM.md` resolution in a native-pi session is
unaffected: it stays with the upstream loader.

The base prompt states collaboration rules explicitly, because omitting them
is what produced silent sessions: "prefer concise, actionable answers" was the
only relevant line, and a reasoning model executed it as saying nothing at all.
Required behaviours, each one an observed failure inverted:

- answer in the language the user writes in
- one sentence before each tool batch in the same assistant message as the
  tool calls, and no silence longer than one tool batch or 60 seconds of work
- anything the user asked is answered in visible text; reasoning is not shown
  to them and does not count as an answer
- the final message is self-contained
- work is carried through end to end rather than stopping at analysis
- tool calls go through the native tool-call interface; a call written as prose
  (notably an OpenAI-style `multi_tool_use.parallel` wrapper) does not run, and
  the runtime logs it when a model emits one

It also states a search preference that matches the host-side budgets in
[16-tool-result-limits](16-tool-result-limits.md): scope `read`, `grep`, and
`glob` with their own parameters instead of hand-rolling `cat`/`sed`/`grep`/
`find`. `read` accepts only an existing regular text file. When a file name is
uncertain or a directory must be listed, an Agent activates `glob` for the
current prompt through `tool_search` instead of guessing a name or reading the
directory. `glob.path` is a directory, while `grep.path` may be one file or a
directory tree. Calls use `read.offset/limit`, `glob.path/limit`, and
`grep.path/include/outputMode/headLimit`; `filesWithMatches` or `count` avoids
unneeded content. Workspace-relative paths remain the portable default, with a
bounded command in the active shell only when native tools are insufficient.
Grep uses a system `rg` when one is installed and an in-process searcher
otherwise; the agent calls Grep rather than shelling out to `rg`. Bash must
still not assume `rg` is present. The agent must not repeat a search whose
answer is already in context.

The edit-discipline block carries the line-anchored `edit` contract of
[18-line-anchored-edit-contract](18-line-anchored-edit-contract.md): the op
table, the `+`-only body rule, "ranges name changed lines only", "re-ground on
the tag returned by every successful write", and the worked anti-patterns. The
sidecar's `edit` schema is `{ path, tag, ops }`; `old_string` and `new_string` no
longer exist, and the sidecar's tool description must stay byte-identical in
substance to host-core's `builtin_tool_defs()` entry, because a model taught one
grammar and validated against another fails every call.

### 7.1 Active tool context and on-demand loading (D185, ADR 0048)

The sidecar builds one complete tool registry, but it does not serialize every
registered schema into every provider request. Each new user prompt starts with
the mode's core set plus any deferred tools that can be restored from successful
activation evidence still present in the effective session context:

- Agent: `read`, `bash`, `edit`, and `write` (matching pi's coding-agent core)
- Agent: `skill` whenever the skill catalog is non-empty (D404, ADR 0230) — the
  `# Skills` section and a user-typed `/skill-id` both ask the model to call
  it, and a tool that is missing from the schema cannot be called at all
- Agent: `task`, `task_wait`, `task_list`, and `task_stop` as well, whenever the
  subagent catalog is non-empty (§5f) — a capability the model has to go
  looking for is one it will not use, and the delegation lifecycle is worth
  the extra schemas per request
- Plan: `read`, `glob`, `grep`, `browser_preview`, and `bash`
- both modes: `tool_search` when at least one deferred capability exists

In Agent mode, `glob` and `grep` join `browser_preview`, plugin tools,
and plugin-development helpers in the deferred set. Both contract modes keep
their read/inspection core available, while the kind's submit tool
(`submit_plan` or `submit_goal`) is exposed only during the planning state, and
only for the active kind. Deferred tools are registered but their names and
compact
one-line descriptions appear in an `# On-demand tools` catalog; parameter
schemas do not. The catalog is bounded so a plugin with many tools cannot
recreate the original prompt bloat.
The model calls `tool_search` with an exact name or a short capability query.
The sidecar activates up to four matches, returns their names through
pi-agent-core's `addedToolNames`, and rebuilds the next-turn context with those
schemas. Providers with native deferred-tool search receive the definitions at
that load point; other providers receive the active definitions normally.

At the start of each new user prompt, the sidecar clears the in-memory deferred
activation set and rebuilds it from the effective context. Successful
`tool_search` results contribute their `addedToolNames`; successful results from
deferred tools contribute that tool's name. Only names still present in the
current mode's deferred catalog are restored. Failed rows, interrupted or
missing-result placeholders, and assistant/user prose never activate a tool.
The tool registry, host permission path, tool timeout, and workspace containment
rules remain unchanged. `tool_search` is local to the sidecar and does not cross
the host RPC boundary. Its activation marker is retained in the persisted tool
result, so a runtime restart or a new prompt can reuse an eligible capability
while that evidence remains in the effective context; a fresh search is still
required after the evidence is compacted away or otherwise absent.

For user-visible HTML deliverables, the default system prompt asks the agent to
activate `browser_preview` once after creating the page or making its first
meaningful visual edit, using a workspace-relative path. The agent reuses the
live-reloading preview while iterating instead of issuing repeated preview
calls. Generated, test-only, and non-visual HTML files are excluded. When the
tool is deferred, `tool_search` must activate it before the preview call.
### 7.2 Plan prompt requirements

The Plan prompt tells the same Agent to understand the request, inspect the
relevant repository/specification/test context, identify impacted files and
risks, include focused validation and migration/recovery implications, surface
open questions. When any initial or revised plan is ready, it must call
`submit_plan` immediately exactly once in the current turn with one complete
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
asks about anything ambiguous first, then calls `submit_goal` immediately exactly
once in the current turn with one complete Markdown snapshot.

The one-submit rule, the historical-checkpoint rule, the revise-after-close rule,
the no-chat-confirmation rule, and the host-writes-the-artifact rule are the same
as Plan's, with `submit_goal` and `.pi/goal/*.md` in place of their Plan
equivalents. The prompt additionally states that once approved, the contract is
the standard the Agent works against: it pursues the goal autonomously, chooses
its own approach, and stops only when every acceptance criterion is verified or a
boundary blocks it.

### 7.2b Subagent prompt composition (D201, ADR 0062)

A delegate's system prompt is composed in the sidecar from three parts, in this
order: the delegation framing, the definition's Markdown body, and the tool
guidance its resolved tools earn. The body sits ahead of the workspace guidance
so a project's own instructions still have the last word.

The framing states the shape of the delegate's situation, which is not
inferable from the body: it is one delegated task, the delegate cannot see the
user, ask a question, or delegate further, it has exactly the listed tools, and
its final message is the only thing the main agent receives. Listed names are
the spawn-time resolved set when `tools: inherit` is on. A read-only
definition is additionally told never to report an edit it could not have made;
a write-capable one is told to touch only the files the task is about.
Mutation framing uses the resolved set, not the raw frontmatter extras.

Guidance blocks are the same text the session prompt uses, included only when
the resolved tools include the matching name: search/read scoping for
read/grep/glob, edit discipline for edit/write, the command shell contract for
Bash, the `# Skills` catalog when `skill` is present, and the scratch-directory
rule when the session has a scratch directory and the delegate can write. The
project instruction chain (§7.3) is appended last, so a delegate follows the
same project rules as its session.

### 7.3 Project instruction chain

The Electron main process first resolves the global
`~/.pi/agent/AGENTS.md`, then project instruction files inside the
session-bound project root when a runtime starts. For each project directory it
uses at most one non-empty file in this order: `AGENTS.override.md`, `AGENTS.md`,
`CLAUDE.md`, then `.claude/CLAUDE.md`. Entries are concatenated from project
root to the target directory, so the closest file appears last and takes
precedence. The initial chain targets the project root. Before a `read`,
`write`, `edit`, or `browser_preview` call, the sidecar asks Electron main to
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
again when a relevant file tool runs. The resolver's timeout and fallback
are operational safeguards; they do not emit a separate timing log record.

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
| `task` calls in one assistant message | parallel; 10 running delegates per session (ADR 0089) |

Tool concurrency is expressed through pi execution modes: every catalog tool is
`sequential` and `task` alone is `parallel`, and pi runs a batch sequentially as
soon as it contains one sequential tool. So an all-`task` batch is the only batch
that fans out, and every other ordering guarantee is unchanged. Delegates issue
host calls independently, and host-core's one-mutation-per-session admission
keeps writes from tearing but leaves two same-path mutations unordered, so the
sidecar serializes `write`/`edit` calls that target the same normalized path
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

## 12. Native Pi continuation runtime (ADR 0254)

The sidecar selects runtime by session source. Desktop-owned ids continue to use
`DesktopAgentRuntime`, host turn rows, and the host persistence outbox unchanged.
Opaque `native-pi:` ids use a dedicated coding-agent `AgentSession` constructed
with the original v3 `SessionManager`, Pi `ModelRuntime`, `SettingsManager`, and
`DefaultResourceLoader`. Native context is built by the SDK from the active tree
leaf, compaction, model/thinking changes, and context-bearing custom messages;
it is never reconstructed from renderer `UiMessage` rows.

The first native slice supports text prompt **without model tools**, stop/abort,
and explicit refresh. `createAgentSession` receives `noTools: "all"`; neither
built-in nor extension tools may bypass Desktop permissions. Tool parity awaits
an explicit permission bridge. Native extension startup/resource discovery binds
with the SDK headless UI and unsupported session-control actions; guards and
listeners are installed before startup appends. Binding failure disposes the
session and releases ownership. Pi extensions remain trusted local code, not
Desktop plugins.

A native fork (`native.session.fork`) branches the parent snapshot in memory:
the SDK extracts the anchored branch using its native label/compaction
re-chaining rules, drops later and sibling entries, and never touches the parent
file or its manager. When the anchored branch recorded no model, the child
records the parent session's saved provider/model; when it recorded no
thinking-level change, it records the parent's saved level, while an explicit
branch value (including off) wins. The child is published as a complete new
file whose staged and published bytes must still match the captured
device/inode/size/hash before it is projected or registered; an altered file
fails closed without returning a child. A fork is a data-only copy: it executes
no model and loads no project resources, so it stays available while the parent
is provider-unavailable or project-untrusted, without granting prompt

ModelRuntime performs its public offline initialization to restore the local
catalog and auth snapshot. Native Composer readiness uses native `canPrompt`,
not Desktop provider or secret availability. Owned idle leases remain usable;
active turns stay stoppable through retries/compaction, reject overlap without
disposal, and publish exactly one terminal event after SDK prompt settlement
and final persistence (including `agent_settled` hooks). An error rejection
uses the error terminal path instead.

The native dispatcher carries the optimistic `userMessageId`; a
`user_message_persisted` event acknowledges the SDK-assigned durable entry ID
after the guarded append. No caller ID is written into native JSONL. The
renderer reconciles active, retained, and cached rows by identity, never text.
Native abort refreshes the original transcript instead of smart-stop rewrite.

The saved provider/model and configured Pi auth must resolve exactly; there is
no Desktop provider fallback. Missing cwd, required project trust, unsupported
format, repair-needing newline, unavailable provider/auth, active lease, or
external byte change makes continuation fail closed while detail remains
browseable.

### Provider certificate trust (issue #714)

The desktop sidecar starts with Node's `--use-system-ca`, retaining bundled
roots and inherited `NODE_EXTRA_CA_CERTS`. It uses the OS trust store without
turning off chain or hostname validation. Restart after updating local trust
or the extra-CA startup environment. Headless pi-host launch behavior and
System/Direct/Custom proxy routing are unchanged.

Explicit certificate verification errors are terminal for both setup and
stream recovery in main sessions and built-in delegates. Their structured
cause survives adapter message flattening, remains on the final error row,
and never triggers a provider transport rebuild. Protocol errors such as
`EPROTO` keep their existing retry behavior. See
[certificate trust ADR](../../adr/provider-system-certificates.md).
