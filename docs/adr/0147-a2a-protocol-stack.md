# ADR 0147: A2A Protocol Stack for Subagent Coordination

- Status: Superseded by ADR 0165
- Date: 2026-09-02
- Deciders: PI-Desktop core
- Related: D277, D318, D321, ADR 0062, ADR 0089, ADR 0100, ADR 0162, ADR 0164,
  `03-runtime/02-agent-runtime.md` §5f.2,
  `03-runtime/06-host-rpc-protocol.md` §4, E2E-165, E2E-165b, E2E-165c, E2E-165d
- Supersedes: ADR 0138 and ADR 0140. The in-process `SubagentMailbox` and the
  single `Peer` tool are removed. The coordination need those ADRs identified
  is preserved; the mechanism is replaced.
- Amended by: ADR 0162 lifts same-context-only addressing. ADR 0164 lets the
  parent agent register as `kind: "parent"` and call `A2A` to other parents;
  parents still cannot address subagents.

## Context

ADR 0138 introduced a session-scoped `SubagentMailbox` and delegate-only peer
tools; ADR 0140 folded them into one `Peer` tool with `send | inbox | wait`
actions.

## Decision

Replace peer messaging with a real **A2A (Agent2Agent) protocol stack** whose
broker lives in the Rust host-core process. Each subagent in the agent-runtime
sidecar is an A2A **client** that reaches the broker over the existing stdio
JSON-RPC 2.0 / NDJSON transport — the same pipe the `plans.*` domain uses —
through a new `a2a.*` method domain.

## Consequences

Superseded (Superseded by ADR 0165). The full record is in git history.
