# ADR 0048: Lazy per-turn tool activation

- Status: Accepted
- Date: 2026-08-02

## Context

PI-Desktop currently registers the product tools, plugin tools, skills, and
plugin-development helpers before the first provider request. The complete
JSON schemas are then serialized into that request even when the prompt is a
greeting or a read-only task. This makes the first input disproportionately
large and repeats the same optional schemas on every new user turn.

pi's coding-agent surface separates the active tool set from the complete
registry and uses compact prompt snippets for capabilities that are not active.
pi-agent-core also supports replacing the context at a turn boundary and
marking tool results with `addedToolNames`; pi-ai adapters can use that marker
for native deferred-tool search when the provider supports it.

## Decision

PI-Desktop keeps a complete sidecar-local tool registry but sends an active
subset to the provider:

- Agent starts with `Read`, `Bash`, `Edit`, and `Write`, matching pi's
  coding-agent core.
- Chat starts with `Read`, `Glob`, and `Grep`.
- A local `ToolSearch` tool remains active when deferred capabilities exist.
  *(ADR 0061 removed the `CompactContext` tool that this list also kept
  always-active; ADR 0064 restores it as `new_context`, again always-active in
  every mode.)*
- Agent-mode `Glob` and `Grep`, `BrowserPreview`, plugin tools, `Skill`, and
  plugin-development helpers are deferred until requested.

The base prompt contains a bounded `# On-demand tools` catalog with names and
compact one-line descriptions, never the deferred JSON parameter schemas. The
model calls `ToolSearch` with an exact name or a short capability query. The
sidecar ranks matches, activates at most four, returns their names in
`addedToolNames`, and rebuilds the context before the next provider request.
Providers with native deferred-tool search can serialize the newly activated
schemas at that load point; providers without it receive the active schemas
through the ordinary tool list.

The deferred set is cleared at the start of every new user prompt. ToolSearch
does not call host-core and does not bypass permissions, workspace containment,
timeouts, or audit behavior. The activation marker is retained inside the
persisted tool result so transcript reconstruction preserves provider message
semantics. A restarted runtime still requires a new ToolSearch call before it
uses a deferred capability.

## Consequences

- Simple first turns no longer pay for every optional tool schema.
- Core coding workflows keep pi's Read/Bash/Edit/Write set without an extra
  discovery call; file enumeration and search remain one ToolSearch away.
- A task that needs an ancillary capability incurs one explicit ToolSearch turn
  before that capability is available.
- ToolSearch is a normal model tool activity row, so the discovery step is
  visible and durable rather than an opaque side effect.
- Provider compatibility remains centralized in pi-ai: native deferred search
  is an optimization, while the active-context fallback works for every
  adapter.
- Plugin descriptions are bounded in the prompt catalog, and large plugin
  registries cannot reintroduce the original schema flood.

## Alternatives

### Send every schema on every request

Rejected because it wastes first-turn context on capabilities the model does
not need and grows with the plugin registry.

### Activate tools from a prompt-text heuristic

Rejected because user wording and project instructions are not a reliable
capability classifier, and a missed heuristic would hide a valid tool.

### Use only provider-native tool search

Rejected because not every configured provider supports it. The sidecar needs a
provider-independent active-tool contract, with native search as an adapter
optimization.

## References

- `docs/spec/03-runtime/02-agent-runtime.md`
- `docs/spec/03-runtime/03-tools-and-permissions.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-008a)
- `https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/system-prompt.ts`
- `https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md`
