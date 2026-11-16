# ADR: Ordered preparation and parallel file batches

- Status: Proposed (amended 2026-10-30 by #1982; see
  [Host file admission](host-file-batch-admission.md))
- Date: 2026-10-12

## Context

Independent Read/Glob/Grep calls were serialized, but changing execution flags alone was
unsafe because preflight mutated the prompt in completion order and Task could start a
writable delegate beside a parent read; the first #1982 attempt at lexical-path claims for
Write/Edit was rejected since differently named files can reference the same object.

## Decision

Use pi-agent-core's ordered preparation, concurrent execution, and source-order result
submission contract: native path instruction preparation follows parent mode and extension
checks, children only mutate their own prompt, prepared argument identity keeps execution
on the same normalized parameters, and direct calls keep preflight, without forking pi or
adding another executor. Read/Glob/Grep remain parallel candidates, and a supported local
Host lets Write/Edit join while legacy and remote Hosts keep sequential writes; Task-only
fan-out is preserved, Task mixed with any file tool keeps the batch sequential, and reads
or searches after a writable Task wait for that delegate. Eligible parallel file calls
register in source order, seal before dispatch, and carry Host tickets, with the Host
owning actual identity, conflicts, capacity, and execution lease lifetime, while outer
executor cleanup covers argument failures, mode denials, cancellation, and calls that
never reach the Host.

## Consequences

- Independent known-file reads and writes may overlap while aliases keep source order, and
  uncertain paths, namespace changes, and searches coordinate through the Host file
  domain.
- Per-session write capacity remains one, results enter the model in source order, and
  Task and Bash semantics and permissions are unchanged.
- Legacy PathMutex behavior remains only on the legacy path.

## Alternatives

- Completion-order preflight: sibling calls race to choose prompt instructions.
- Sidecar lexical locks: miss aliases and other sessions.
