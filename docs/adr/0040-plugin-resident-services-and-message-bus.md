# ADR 0040: Resident plugin services and the inter-plugin message bus

- Status: Accepted
- Date: 2026-07-31
- Related: [Plugin lifecycle](../spec/07-plugins/05-plugin-lifecycle.md),
  [ADR 0008](0008-plugin-runtime-isolation-target.md)

## Context

A plugin could only work when something called into it, so watchers, pollers,
and sync workers had no supported home, and the host could neither report nor
restart timers started inside `onLoad`. Inter-plugin messaging was equally
missing: `pi.events.on` / `off` were no-ops, and the wire protocol carried only
request/response frames initiated by the child.

## Decision

The broker gains a one-way parent→child `event` frame, which carries the message
bus and finally implements `pi.events.on` / `off`. A resident service is
declared in `contributes.services`, gated on `background.service`, and run by
the broker: started after `onLoad`, stopped before `onUnload`, living in the
plugin's `utilityProcess`, where a crash restarts the whole plugin under
supervised backoff until it stays `failed`. Bus traffic must be declared in
`contributes.bus.publish` / `contributes.bus.subscribe`, since a granted
`bus.publish` or `bus.subscribe` permission alone routes nothing, and topics are
dot-separated pattern segments. The broker alone routes messages by `topic`,
excluding the publisher from its own fan-out, enforces payload, subscription,
and rate caps that fail `LIMIT_EXCEEDED` / `RATE_LIMITED`, and treats a payload
as data that grants a subscriber no new capability. Manual enable and disable
outrank supervision by cancelling timers and clearing attempt counters.

## Consequences

- A background worker becomes visible and supervised: the user sees it run,
  restart, or give up, with per-service state over `plugin/services`.
- Restarting the plugin rather than the service is coarse, but the crash that
  killed the service already destroyed its process.
- Declared topics keep plugin coupling reviewable, and any subscriber with a
  matching pattern sees the topic, so secrets do not belong on the bus.

## Alternatives

- Let plugins start their own timers: rejected, the host cannot stop, report, or
  restart work it does not know about.
- An open pub/sub with permissions only: rejected, a grant would mean "talk to
  every plugin about anything" and be unreviewable.
