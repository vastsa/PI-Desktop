# ADR 0073: Stage next-turn composer configuration and preserve stopped throughput

- Status: Accepted for implementation
- Date: 2026-08-11
- Deciders: PI-Desktop core
- Amends: D189
- Related: D212 · [Agent runtime](../spec/03-runtime/02-agent-runtime.md) ·
  [Component spec](../spec/04-ux/08-component-spec.md) · E2E-120

## Context

The composer previously made its draft, mode, thinking, and permission controls
read-only for an entire agent run. That prevented preparing the next prompt and
next-turn configuration while preserving the correct safety rule: host-core must
not mutate the configuration pinned by an in-flight turn.

## Decision

1. During an active turn, the composer draft and mode, thinking, and permission
   selectors remain editable.
2. The renderer stores the latest full session configuration per running session
   and projects it optimistically.
3. Runtime terminal messages preserve `responseDurationMs`.
4. Rust transcript conversion persists both optional fields in message metadata.

## Consequences

- Users can prepare the next request and adjust its operating profile without
  waiting for the current answer, but cannot send a concurrent prompt.
- Host idle-only admission, one-turn-per-session, Plan/Goal approval, and
  permission enforcement remain unchanged.
- Stopped partial answers show a stable approximate tokens-per-second value and
  retain it after reload; complete answers continue to use exact provider usage.
- `responseOutputTokens` is an additive shared field stored inside existing
  message metadata, so neither protocol v9 nor storage schema v11 changes.

## Alternatives considered

### Configure the host immediately while running

Rejected. It would either violate idle-only admission or risk changing the
permission/tool/model configuration already pinned for the active turn.

### Keep controls disabled but allow only draft typing

Rejected. Mode, thinking, and permission are part of preparing the next prompt;
making only text editable leaves the workflow unnecessarily serialized.

### Hide throughput when final usage is missing

Rejected. The visible partial output and measured stream interval provide a
useful estimate, and the UI can distinguish it from provider-reported usage.
