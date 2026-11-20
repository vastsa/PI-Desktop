# ADR: Opt-in background job continuation

- Status: Proposed; implemented locally for review
- Date: 2026-11-15
- Related: #2143, session-scoped background job controls

## Context

TaskWait already supports long commands while a turn remains active. #2143 asks
for a different lifecycle: a command finishes after the assistant has ended its
turn, and the original session resumes without new user input. Making this
implicit for every background command would also resume servers/watchers and
change existing expectations. Cancellation, result retention and permissions
therefore need an explicit ownership contract.

## Decision

Keep ordinary background Bash and TaskWait unchanged by default. A default-off
application execution setting allows the assistant to register `notifyOnExit`
for a finite local parent-Agent job, without a separate human approval per job.
The Host owns job identity, bounded retained output and one-shot continuation
state; Main owns admission through the existing AgentHost and prompt handler.
A Symbol and WeakMap carry origin, so renderer/plugin JSON cannot forge it.

Pending intents pin their original result, capped at 64 per Host. They become
ready only after process/output settlement and the source turn completes.
Active work and user queues retain priority. A claim under Host state locking
is the start boundary: settings/cancellation/result receipt that precede it win;
disabling afterward does not interrupt that already-started turn. Dispatch
failures become terminal rather than repeatedly starting a model request.

Automatic delivery is a bounded TaskWait result with a synthetic call/result
pair in provider context, persisted as a tool row. It is not a user message or
system instruction. Current session permissions remain authoritative. Main
acknowledges normal terminal tool results; mere output inspection does not
consume delivery. Failed acknowledgements suppress local dispatch and retry.

## Consequences

Ordinary sessions incur no extra model turn by default. Enabled continuation may
use additional provider tokens under the existing session permissions. Retention
is bounded, and the one-shot claim favors avoiding duplicate execution over
automatic recovery from an ambiguous startup failure.

## Alternatives and limits

Keeping a turn open via TaskWait already works and remains the default. A
renderer timer cannot own delivery because navigation/reload must not lose it.
Putting completion text in the durable user queue would invent user authority
and make cancellation stale; instead Host retains a cancellable intent until
Main can enter the normal serial admission path. No new scheduler or database
is introduced. Intents expire with Host lifetime. Remote/native sessions,
subagent jobs, contract modes and unbounded watcher semantics are not extended.

## Validation

Host tests exercise one-shot original-output claims, disabled registration,
withdrawal/consumption and session isolation. Main/AgentHost tests cover busy
sessions, identity, user priority and revocation before dispatch. Runtime and
existing job-tool tests protect the opt-in schema and ordinary wait behavior.
`scripts/e2e-background-continuation.mjs` combines a deterministic local provider,
production runtime/Main admission and real Host/processes: turn one ends before
the test is released, then exactly one automatic turn receives its exit code
and final stderr without new user input. This is not a live-provider or full
Electron-window acceptance test.
