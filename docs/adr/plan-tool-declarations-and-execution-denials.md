# ADR: Keep known tool declarations while denying contract-mode execution

- Status: Accepted for implementation
- Date: 2026-09-28
- Amends: ADR 0062 (declaration visibility only)
- Related: #1174

## Context

Plan/Goal removed editing and delegation tools from the provider request while
retaining earlier tool-call history. A model that repeats one of those names can
be rejected by a strict gateway before PI-Desktop receives the call.

## Decision

Keep Write and Edit declarations in the main session's Plan/Goal requests. When
subagents are configured, retain the Task/TaskWait/TaskList/TaskStop schemas
too.

Keep the current mode allowlist authoritative for execution. Block prohibited
calls before extension call hooks or tool handlers run.

## Alternatives

- Delete or rewrite old tool history: changes useful context without proving
  that history caused the model's next invalid call.
- Add a user-message correction after a gateway failure: cannot produce a normal
  paired tool result and introduces a separate recovery policy.
- Declare every plugin/tool: expands context and capability disclosure beyond
  the known mode-restricted tools needed by this failure path.
- Permit editing in Plan/Goal: violates the existing execution boundary.

## Consequences

Declared tools no longer imply permission to execute them.

No database, IPC, plugin permission or host ownership migration is required.
