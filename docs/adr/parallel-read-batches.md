# ADR: Ordered preparation and parallel file batches

- Status: Proposed
- Date: 2026-10-12
- Amended: 2026-10-30 by #1982; see [Host file admission](host-file-batch-admission.md)

## Context

Independent Read/Glob/Grep calls were serialized. Simply changing execution
flags was unsafe because preflight mutated the prompt in completion order and
Task could start a writable delegate beside a parent read.

## Decision

Use pi-agent-core's ordered preparation, concurrent execution and source-order
result submission contract. Native path instruction preparation follows parent
mode/extension checks; children only mutate their own prompt.

Read/Glob/Grep remain parallel candidates. A supported local Host allows
Write/Edit to join; legacy and remote Hosts retain sequential writes.

## Consequences

Independent known-file reads and writes may overlap while aliases keep source
order.

Regression tests must distinguish RPC submission from actual file-body order.

## Alternatives

- Completion-order preflight: sibling calls race to choose prompt instructions.
- Sidecar lexical locks: miss aliases and other sessions.
- Write-only Host capacity: does not exclude a read of the same file.
- Waiting/releasing only inside the builtin body: validation/mode errors can
  strand registered successors before reaching that body.
