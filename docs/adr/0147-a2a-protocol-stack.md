# ADR 0147: A2A Protocol Stack for Subagent Coordination

- Status: Superseded by ADR 0165
- Date: 2026-09-02
- Related: D277, D318, D321, ADR 0062, ADR 0089, ADR 0100, ADR 0162, ADR 0164,
  E2E-165, E2E-165b, E2E-165c, E2E-165d
- Supersedes: ADR 0138 and ADR 0140
- Amended by: ADR 0162 (lifts same-context-only addressing), ADR 0164 (parents
  register as `kind: "parent"`)

## Context

ADR 0138 and ADR 0140 kept subagent coordination inside the Node sidecar, where
messages were fire-and-forget with no durable history, typed payloads,
discovery, or authorization beyond a runtime-supplied sender name.

## Decision

Replace peer messaging with an A2A stack brokered in Rust host-core: each
subagent is an A2A client over the existing stdio JSON-RPC transport through a
new `a2a.*` method domain, with an in-memory agent card registry, durable
`a2a_tasks` state machines, typed `TextPart` / `FilePart` / `DataPart` payloads,
counterpart-based event routing, and host-minted per-agent capability tokens,
while one subagent tool `A2A` replaces `Peer`.

## Consequences

- Coordination became durable and typed, and the forged-sender invariant held
  because the token never reached the model.
- Protocol v10 and schema v12 broke compatibility for older hosts.

Superseded by [ADR 0165](0165-withdraw-a2a-peer-stack.md).
