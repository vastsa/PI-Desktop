# ADR 0018: Carry thinking mode through the complete session pipeline

- Status: Accepted
- Date: 2026-07-26

## Context

The desktop once showed an effort label that lived only in renderer state: the pi
runtime ran with reasoning disabled, the level never crossed IPC, and thinking
events had no durable or visible form. Removing that decorative control fixed the
misleading UI but left reasoning-capable models without a selector, although Pi
already exposes reasoning metadata, supported levels, provider-specific request
serialization, and separate thinking stream blocks.

## Decision

Thinking mode is session-scoped runtime configuration with the canonical levels
`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`, carried along one
path:

```text
model capability -> session.thinkingLevel -> renderer/main IPC
-> sidecar prompt -> pi Agent thinkingLevel -> thinking stream events
-> UiMessage.thinking -> host canonical blocks -> transcript disclosure
```

- Model capability comes from pi's catalog unless the provider sets an explicit
  override, a provider without reasoning resolves to `off`, the renderer and Main
  apply the capability-aware nearest-supported clamp, and the host validates the
  enum without provider knowledge.
- The Composer renders the selector only for a reasoning-capable model and persists
  through `session.configure`; thinking text stays separate from answer text in
  streaming, persistence, rendering, and copy.
- Host schema v3 adds `sessions.thinking_level` and stores reasoning as a canonical
  `thinking` content block, migrating v2 sessions to `off`; the shared and host
  protocol version advances to 2.

This extends D091 and records D096: a reasoning control is visible only because it
now has an end-to-end runtime implementation.

## Consequences

- The selection survives restart and applies to the next turn, including sparse
  capability sets such as `["off","high"]`.
- Thinking-only updates open the transcript without an empty answer bubble, and
  search and answer copy exclude thinking text.

## Alternatives

- Renderer-local effort: it cannot affect requests or persist.
- Thinking text inside the answer: it corrupts markdown, copy, search, and pi's
  reasoning/output split.
- One generic reasoning boolean: it discards sparse per-model levels.
