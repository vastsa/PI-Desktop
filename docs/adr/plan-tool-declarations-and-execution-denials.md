# ADR: Keep known tool declarations while denying contract-mode execution

- Status: Accepted for implementation
- Date: 2026-09-28
- Amends: ADR 0062 (declaration visibility only)
- Related: #1174

## Context

Plan/Goal removed editing and delegation tools from the provider request while
retaining earlier tool-call history, so a model repeating one of those names can be
rejected by a strict gateway before PI-Desktop receives the call, leaving the app
unable to produce a tool result with that call's identity.

## Decision

Keep the Write and Edit declarations in the main session's Plan/Goal requests, and
keep the `Task`/`TaskWait`/`TaskList`/`TaskStop` schemas when subagents are configured,
labelled explicitly unavailable in the contract mode; unknown tools, missing subagent
definitions, on-demand tools, and non-plan-safe plugin tools gain no declaration.

The mode allowlist stays authoritative for execution: prohibited calls are blocked
before extension hooks or handlers run, the registered handler is wrapped with a fresh
mode check so an object retained across a mode switch cannot execute on stale
authority, and pi's existing error path returns the failure with the original call id
and continues the model loop. The transcript is retained, and no synthetic call,
replacement id, correction prompt, or retry path is added.

## Consequences

- A declared tool no longer implies permission to execute it, so the mode prompt and
  each denied description must stay explicit.
- The gateway accepts correctly declared calls, and the normal tool-error channel
  gives the model actionable feedback instead of a request-level 502.
- No database, IPC, plugin permission, or host ownership migration is required.

## Alternatives

- Delete or rewrite old tool history — rejected: it changes useful context without
  proving that history caused the invalid call.
