# ADR 0164: Parent agents collaborate across conversations

- Status: Superseded by ADR 0165
- Date: 2026-09-05
- Deciders: PI-Desktop core
- Related: D321, D318, ADR 0147, ADR 0162, ADR 0062,
  `03-runtime/02-agent-runtime.md` §5f.2,
  `03-runtime/06-host-rpc-protocol.md` §4, E2E-165d
- Amends: ADR 0147 (parent must not call `A2A`) and ADR 0162 (no messaging
  with the parent). Subagent sibling coordination is unchanged.

## Context

ADR 0147 kept the `A2A` tool out of the parent catalog so the parent could not
open a second, weaker channel to its own delegates.

## Decision

1. **Each Agent-mode session runtime registers a parent A2A agent** for its
   lifetime (first prompt through dispose). The card uses `kind: "parent"`, name
   `parent` (host-uniquified to `parent-2`, …), and a description that carries
   the session title.

## Consequences

Superseded (Superseded by ADR 0165). The full record is in git history.
