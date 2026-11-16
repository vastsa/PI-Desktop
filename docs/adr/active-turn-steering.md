# ADR active-turn-steering: Bind Composer steering to the active durable turn

- Status: Accepted
- Date: 2026-09-12
- Issue: https://github.com/vastsa/PI-Desktop/issues/164

## Context

The Composer queues follow-ups but cannot redirect a running turn, and a second
prompt is correctly rejected with `AGENT_BUSY`. pi-agent-core already supplies
`Agent.steer`, and Codex's turn/steer contract provides the expected-turn
admission model to follow.

## Decision

Send and Enter stay follow-up; Alt+Enter (Option+Enter on macOS) uses an additive
`agent/steer` channel carrying `expectedTurnId`, with the existing queue slice
submitting optimistic input and restoring rejected drafts, the IPC handler
reusing attachment validation against the running model and workspace, and the
sidecar rechecking the target before calling `Agent.steer`.

Steering keeps the active configuration and durable turn: local foreground shell
and read calls are cancelled and awaited without the normal Stop grace, an
unconfirmed shell failure stays pending until Stop, calls not yet started are
skipped, `TaskWait` yields without cancelling its delegates (issue #1607), and
Stop closes admission while retaining accepted input as history. The event
persistence module journals input through the outbox, `precedingAssistant`
reserves an unfinished reply's position, and the persisted `UiMessage.steering`
marker protects input from Smart Stop across renderer reload, while host
provenance treats steering into a claimed collaboration delivery turn as extra
human input that must target that delivery's session and strips any
client-supplied `session_message` (D597).

## Consequences

- No new provider transport, protocol version, or storage migration is required.
- Streaming reservation updates remain the only exception to append-only message
  persistence.
- Existing regression suites cover surrounding behavior, and
  E2E-AGENT-alt-enter-steers-active-turn stays Draft until rendered E2E
  validation is performed.
