# ADR 0234: Keep project memory host-owned and path-scoped

- Status: Accepted
- Date: 2026-09-12
- Deciders: PI-Desktop maintainers

## Context

Projects need a durable memory surface similar to ChatGPT Projects. Renderer
preferences are not a safe owner for model context: they are presentation state,
can be reset independently, and do not provide a host-enforced boundary when a
session switches projects.

## Decision

Store one user-authored memory document per canonical project path in the
existing host `kv` table under the `projectMemory` namespace. Limit the UTF-8
content to 32 KiB. Electron main loads the value for the session-bound project
path and passes it to the agent runtime. The runtime renders it after project
instructions as explicitly user-provided context and compares it when deciding
whether an idle runtime can be reused.

The memory editor is exposed from the Project archive row menu. Creating a
project keeps the creation surface compact and shows that project memory is
available later; it does not add a memory mode selector whose semantics the
application does not implement.

## Consequences

- Memory survives renderer restarts and is isolated by canonical project path.
- Changing memory retires the next reusable runtime so a follow-up prompt sees
  the new value.
- Project memory cannot override runtime safety, tool, or collaboration rules.
- No schema migration is needed because `kv` is the existing extensibility
  boundary for new configuration domains.
- A future logical project that groups several roots will need an explicit
  project identity and root-membership model; this decision does not infer that
  relationship from the current multi-folder creation flow.
