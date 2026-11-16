# ADR active-turn-steering: Bind Composer steering to the active durable turn

- Status: Accepted
- Date: 2026-09-12
- Issue: https://github.com/vastsa/PI-Desktop/issues/164

## Context

The Composer queues follow-ups, but cannot redirect a running turn. A second
prompt is correctly rejected with `AGENT_BUSY`. pi-agent-core already supplies
`Agent.steer`; Codex's [turn/steer
contract](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn)
provides the expected-turn admission model.

## Decision

Keep Send/Enter as follow-up. Alt+Enter (Option+Enter on macOS) uses an additive
`agent/steer` channel with `expectedTurnId`.

Steering keeps the active configuration and durable turn. Local foreground shell
and read calls receive cancellation; the runtime waits for their results before
the next request, without the normal Stop grace timeout.

## Consequences and validation

No new provider transport, host protocol version, or storage migration is
required.
