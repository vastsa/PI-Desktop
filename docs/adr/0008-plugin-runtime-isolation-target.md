# ADR 0008: Plugin runtime targets isolation in a separate process

- Status: Accepted (Implemented 2026-07-29)
- Date: 2026-07-25

## Context

Plugin code is untrusted; we must prevent it from dragging down or intruding
into the host.

## Decision

Target architecture: the plugin main runs in a **separate process**
(UtilityProcess/Child Process) and accesses the Host API via RPC.

If MVP progress is constrained, a lighter isolation may be adopted temporarily,
but it must not break:

- The permission gateway
- The API allowlist
- Unified registration of contribution points
- Crash non-fatality

## Rationale

1. Crash isolation
2. Clearer permission proxying
3. Resource limits can be added later

## Consequences

### Positive
- Better security and stability

### Negative
- Higher implementation and debugging cost
