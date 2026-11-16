# ADR 0040: Resident plugin services and the inter-plugin message bus

- Status: Accepted
- Date: 2026-07-31
- Related: [Plugin lifecycle](../spec/07-plugins/05-plugin-lifecycle.md),
  [Plugin IPC and host services](../spec/07-plugins/12-plugin-ipc-and-host-services.md),
  [ADR 0008](0008-plugin-runtime-isolation-target.md)

## Context

Two roadmap items were blocked on the same missing pieces.

## Decision

### One new frame

The broker gains a one-way parent→child frame:

```text
{ t: "event", event, ... }   // no reply, no backpressure
```

`bus.message` is its first user. The same frame finally implements
`pi.events.on` / `off`, which now sees the raw event stream.

### Resident services

1. A service is **declared** (`contributes.services`, at most 4 per plugin) and
   gated on `background.service`.
2. The **broker decides when it runs**: `start` after `onLoad` completes (5s
   budget), `stop` before `onUnload`.
3. A service lives in the plugin's `utilityProcess` (ADR 0008), so a crash takes
   it down with the process.
4. After the last attempt the plugin stays `failed`.
5. Manual enable / disable outranks the supervisor: an explicit user action
   cancels the pending timer and clears the attempt counter.

### Message bus

1. Traffic is **declared in the manifest**: `contributes.bus.publish` lists
   concrete topics, `contributes.bus.subscribe` lists patterns.
2. Topics are dot-separated segments (`[a-zA-Z0-9][a-zA-Z0-9_-]*`, ≤8 segments,
   ≤128 chars).
3. **Routing lives in the broker.** A message carries `topic`, `from`,
   `payload`, and a host-assigned `at`.
4. Caps: 64KB per payload, 16 subscriptions per plugin, 100 publishes per
   rolling 10s window; over-cap calls fail `LIMIT_EXCEEDED` / `RATE_LIMITED` and
   are audited with the topic.
5. A payload is **data, never capability**.

## Consequences

- A background worker is now a first-class, visible, supervised thing: the user
  sees it running, sees it restart, and sees it give up.
- Restarting the plugin rather than the service is coarse — a crash re-runs
  `onLoad` — but it is the only honest unit, because the crash already destroyed
  the process the service lived in.
- The 5-attempt ceiling means a genuinely broken service stops retrying.
- Declared topics make plugin-to-plugin coupling reviewable, and let the host
  reject undeclared traffic without knowing anything about payload semantics.
- Because the publisher is excluded from its own fan-out, a plugin cannot use
  the bus as an internal event emitter — it must use ordinary function calls,
  which is what it should have done anyway.

## Alternatives

### Let plugins start their own timers and call it a service

Rejected. That is the status quo.

### Restart the service in place instead of the plugin

Rejected. The service runs inside the plugin's process; if it crashed the
process, there is no in-place to restart into.

### Unlimited restarts

Rejected. A crash loop with backoff still burns CPU forever and hides the
failure behind a chip that flickers between `starting` and `failed`.

### An open pub/sub with permissions only

Rejected. `bus.publish` would then mean "talk to every plugin about anything",
which is unreviewable.

### Direct plugin-to-plugin RPC

Rejected. It creates hard dependencies between independently installable,
independently versioned plugins, and it hands one plugin a handle on another.
