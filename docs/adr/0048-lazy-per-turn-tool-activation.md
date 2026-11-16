# ADR 0048: Lazy per-turn tool activation

- Status: Accepted
- Date: 2026-08-02

## Context

PI-Desktop currently registers the product tools, plugin tools, skills, and
plugin-development helpers before the first provider request. The complete JSON
schemas are then serialized into that request even when the prompt is a greeting
or a read-only task.

## Decision

PI-Desktop keeps a complete sidecar-local tool registry but sends an active
subset to the provider:

- Agent starts with `Read`, `Bash`, `Edit`, and `Write`, matching pi's
  coding-agent core.
- Chat starts with `Read`, `Glob`, and `Grep`.
- A local `ToolSearch` tool remains active when deferred capabilities exist.
- Agent-mode `Glob` and `Grep`, `BrowserPreview`, plugin tools, `Skill`, and
  plugin-development helpers are deferred until requested.

The base prompt contains a bounded `# On-demand tools` catalog with names and
compact one-line descriptions, never the deferred JSON parameter schemas. The
model calls `ToolSearch` with an exact name or a short capability query.

## Consequences

- Simple first turns no longer pay for every optional tool schema.
- Core coding workflows keep pi's Read/Bash/Edit/Write set without an extra
  discovery call; file enumeration and search remain one ToolSearch away.
- A task that needs an ancillary capability incurs one explicit ToolSearch turn
  before that capability is available.
- ToolSearch is a normal model tool activity row, so the discovery step is
  visible and durable rather than an opaque side effect.
- Provider compatibility remains centralized in pi-ai: native deferred search is
  an optimization, while the active-context fallback works for every adapter.

## Alternatives

### Send every schema on every request

Rejected because it wastes first-turn context on capabilities the model does not
need and grows with the plugin registry.

### Activate tools from a prompt-text heuristic

Rejected because user wording and project instructions are not a reliable
capability classifier, and a missed heuristic would hide a valid tool.

### Use only provider-native tool search

Rejected because not every configured provider supports it.

## References

- `docs/spec/03-runtime/02-agent-runtime.md`
- `docs/spec/03-runtime/03-tools-and-permissions.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-008a)
- `https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/system-prompt.ts`
- `https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md`

## Amendment — 2026-09-27: keep workspace search in Agent's initial schema

Routine file discovery should not require a separate `ToolSearch` turn. Agent
now includes `Glob` and `Grep` alongside `Read`, `Bash`, `Edit`, and `Write` in
its initial provider request.

This supersedes only ADR 0048's initial-set and Glob/Grep-deferral bullets and
the corresponding first-turn consequences; successful activation restoration,
provider compatibility, permissions, and host policy are unchanged.
