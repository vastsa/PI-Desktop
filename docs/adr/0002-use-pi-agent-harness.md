# ADR 0002: Use the pi Agent Harness as the kernel

- Status: Accepted
- Date: 2026-07-25

## Context

The product needs an extensible multi-model agent loop, not an in-house
implementation of tool calling, streaming events, and provider adapters.

## Decision

Use `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` as the kernel,
with `@earendil-works/pi-coding-agent` and
`@earendil-works/pi-storage-sqlite-node` optional later.

## Consequences

- Capability gains arrive with pi, and the desktop layer adapts to its event
  model and Node version floor.

## Alternatives

- Own agent loop or another coding agent as kernel: rejected; both contradict
  building on pi.
