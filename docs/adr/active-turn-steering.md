# ADR active-turn-steering: Bind Composer steering to the active durable turn

- Status: Accepted
- Date: 2026-09-12
- Issue: https://github.com/vastsa/PI-Desktop/issues/164

## Context

The Composer already queues follow-ups through the Host-owned FIFO. Users also
need to redirect work before the current turn ends. The runtime previously
exposed prompt, stop and abort only; starting a second prompt while running is
correctly rejected with `AGENT_BUSY`.

Codex's [app-server turn/steer contract](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn)
requires an expected active turn id and appends input without opening a new
turn or changing its configuration. PI-Desktop can provide that admission
contract using the steering queue already supplied by pi-agent-core.

## Decision

Keep normal Send/Enter as follow-up while running. Use Alt+Enter (Option+Enter
on macOS) for steering, independent of the Enter-to-send preference. IME
confirmation and Shift+Enter retain their existing behavior. Idle Alt+Enter
sends normally. During steering, slash-prefixed drafts remain literal input.

Add a desktop `agent/steer` IPC request with an obligatory `expectedTurnId`.
The main-process steering module validates the durable turn and attachments
against the running runtime's project and model. A Composer submission module
owns optimistic rows, rejection rollback and Stop protection; the store wires
these ports to application state. The existing runtime rechecks admission
after asynchronous preparation, then queues all accepted messages through
native `Agent.steer`.
Model, workspace, permissions and plan/goal execution identity remain fixed.
There is no new provider-specific transport, remote RACP method, or new turn.

The current response and started tools finish before input is consumed by the
next model request. Pending input at pi's closing boundary continues under the
same durable turn after the current loop releases its busy state. A parent
waiting for background delegates wakes on steering. Existing recovery owns
failed-request repair; steering never bypasses it. Stop and terminal errors
close admission and retain accepted input as history without replaying it.

Main journals accepted user input through the existing persistence outbox. An
optional `precedingAssistant` snapshot in the user message event reserves an
in-flight reply's position. Host append idempotency has one bounded exception:
a terminal assistant can replace its own indexed streaming reservation. It
retains message order and turn ownership, uses the existing exact-line update,
and keeps completed messages immutable under retries. In-flight checkpoint
recovery also updates a reservation in place. This requires no schema change.

## Consequences

- Follow-up and steering have distinct, predictable lifetimes.
- Stale target rejection restores the Composer draft without failing the run.
- Attachments, stop behavior and durable transcript ownership use existing
  boundaries; streaming checkpoints cannot overwrite a completed reply.
- Completing a reserved reply rewrites one message line through the existing
  transcript update path. Ordinary turns retain append-only persistence.
- A steering submission cannot rewrite tokens already being generated or
  preempt a running tool. Its instruction is available at the next request.

## Validation

Runtime tests exercise a real pi loop with controlled streams/tools, current
turn identity, images, closing-boundary admission, stop/abort, recovery and an
idle parent with live delegates. Desktop tests execute the Composer key
handler, submission workflow and main-process admission, and cover outbox
replacement during an in-flight write. Host tests verify in-place finalization
and crash recovery without changing adjacent user rows, turn ownership or
replay idempotency. E2E-AGENT-alt-enter-steers-active-turn records the full UI
scenario; local E2E remains opt-in.
