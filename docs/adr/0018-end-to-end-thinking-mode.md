# ADR 0018: Carry thinking mode through the complete session pipeline

- Status: Accepted
- Date: 2026-07-26

## Context

The desktop previously exposed an effort label that lived only in renderer
state. The pi runtime was constructed with reasoning disabled, the selected
level never crossed IPC, and assistant thinking events had no durable or visible
representation.

## Decision

Thinking mode is a session-scoped runtime configuration with the canonical
levels `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.

The complete path is:

```text
model capability -> session.thinkingLevel -> renderer/main IPC
-> sidecar prompt -> pi Agent thinkingLevel -> thinking stream events
-> UiMessage.thinking -> host canonical blocks -> transcript disclosure
```

- Model capability is inferred from pi's built-in catalog when the provider has
  no explicit override.
- Capability-aware UI/main/sidecar boundaries use the same nearest-supported
  clamp.
- The Composer renders the selector only for a reasoning-capable selected
  provider/model and persists changes through `session.configure`.
- Thinking text remains separate from answer text in streaming events,
  persistence, rendering, and copy actions.
- Host schema v3 adds `sessions.thinking_level`; assistant reasoning is stored
  as a canonical `thinking` content block.
- The shared/host protocol version advances to 2 because session and message
  wire shapes changed.

## Consequences

- Reasoning selection survives restart and applies to the next turn in that
  session.
- Sparse model capability sets, including models that cannot fully disable
  reasoning and boolean-like custom sets such as `["off","high"]`, resolve
  consistently across Settings, Composer, main, and sidecar.
- Thinking-only stream updates can open the transcript without creating an empty
  answer bubble.
- Search and answer-copy behavior exclude thinking text.
- Older databases migrate additively; older protocol peers fail the normal
  version handshake rather than silently dropping the new fields.

## Alternatives

### Keep effort in renderer-local storage

Rejected because it cannot affect requests or survive as session truth.

### Put thinking text inside the assistant answer

Rejected because it corrupts answer markdown, copy semantics, search text, and
the distinction pi already provides between reasoning and final output.

### Enable one generic reasoning boolean

Rejected because pi models expose different and sometimes sparse supported
levels; collapsing them loses model capability information.

## References

- `docs/spec/03-runtime/01-ipc-protocol.md`
- `docs/spec/03-runtime/02-agent-runtime.md`
- `docs/spec/03-runtime/04-data-storage.md`
- `docs/spec/03-runtime/06-host-rpc-protocol.md`
- `docs/spec/03-runtime/11-provider-model-system.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `docs/spec/08-meta/decisions-log.md` (D096)
