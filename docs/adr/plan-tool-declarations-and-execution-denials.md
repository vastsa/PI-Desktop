# ADR: Keep known tool declarations while denying contract-mode execution

- Status: Accepted for implementation
- Date: 2026-09-28
- Amends: ADR 0062 (declaration visibility only)
- Related: #1174

## Context

Plan/Goal removed editing and delegation tools from the provider request while
retaining earlier tool-call history. A model that repeats one of those names
can be rejected by a strict gateway before PI-Desktop receives the call. The
application then cannot produce a tool result with that call's identity.
Preserving a declaration and granting execution are separate responsibilities.

## Decision

Keep Write and Edit declarations in the main session's Plan/Goal requests.
When subagents are configured, retain the Task/TaskWait/TaskList/TaskStop
schemas too. These tools remain core declarations and are explicitly labelled
unavailable in the contract mode. Unknown tools, missing subagent definitions,
on-demand tools and non-plan-safe plugin tools do not gain new declarations.

Keep the current mode allowlist authoritative for execution. Block prohibited
calls before extension call hooks or tool handlers run. Additionally wrap the
registered handler with a fresh mode check, so an object retained before a
mode switch cannot execute using stale authority. pi's existing error path
returns the failure with the original call id and continues the model loop.
Task denial must occur before creating or controlling any delegate. Host-core
permission checks, including hard Plan/Goal Write/Edit denial, remain unchanged.

The transcript is retained. No synthetic tool call, replacement call id,
extra user correction prompt, provider-error classifier or retry path is added.
Returning to Agent restores normal execution through existing permission gates.
Subagent tool scopes and their isolated histories remain unchanged.

## Alternatives

- Delete or rewrite old tool history: changes useful context without proving
  that history caused the model's next invalid call.
- Add a user-message correction after a gateway failure: cannot produce a
  normal paired tool result and introduces a separate recovery policy.
- Declare every plugin/tool: expands context and capability disclosure beyond
  the known mode-restricted tools needed by this failure path.
- Permit editing in Plan/Goal: violates the existing execution boundary.

## Consequences

Declared tools no longer imply permission to execute them. Models see a small
number of denied schemas, so the mode prompt and each denied description must
remain explicit. The normal tool-error channel provides actionable feedback
without a request-level 502 when the gateway accepts the declared call.
A gateway rejecting a correctly declared tool or inventing an unknown tool
remains a separate interoperability failure; this decision does not promise
that every third-party model will obey the mode prompt.

No database, IPC, plugin permission or host ownership migration is required.
