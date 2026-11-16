# ADR 0002: Use the pi Agent Harness as the kernel

- Status: Accepted
- Date: 2026-07-25

## Context

We need an extensible multi-model agent loop, rather than implementing tool
calling, streaming events, and provider adapters from scratch.

## Decision

Use the following packages as the kernel:

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`

Optionally adopt later:

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-storage-sqlite-node`

## Rationale

1. Unified LLM provider interface
2. Clear agent event model, well suited to a desktop UI
3. Provides extensibility across the tool calling / session / skills ecosystem
4. Projects such as LiveAgent have already validated it as a viable kernel for
   desktop products

## Consequences

### Positive
- Avoids building an in-house agent framework
- Can keep pace with upstream capability evolution

### Negative
- Requires adapting to pi's events and version constraints (Node >= 22.19)
- Some desktop product requirements must be filled in at the upper layer
  ourselves (permission UX, session product model)

## Alternatives

- Build our own agent loop: high cost, no
- Use another coding agent directly as the kernel: inconsistent with the "based
  on pi" goal
