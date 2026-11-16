# ADR 0048: Lazy per-turn tool activation

- Status: Accepted (amended 2026-09-27: Agent keeps `Glob`/`Grep` in its initial schema)
- Date: 2026-08-02

## Context

PI-Desktop registered product tools, plugin tools, skills, and plugin-development
helpers before the first provider request and serialized every JSON schema into
it, even for a greeting, so the first input was disproportionately large. A
turn-boundary context replacement lets only the requested schemas reach the
provider.

## Decision

Keep a complete sidecar-local tool registry and send only an active subset: Agent
starts with `Read`, `Bash`, `Edit`, `Write`, `Glob`, and `Grep`, Chat with `Read`,
`Glob`, and `Grep`, and `BrowserPreview`, plugin tools, `Skill`, and
plugin-development helpers stay deferred until requested. A local `ToolSearch` tool
stays active while deferred capabilities exist (ADR 0061 dropped the always-active
`CompactContext` tool; ADR 0064 restores it as `new_context`, active in every
mode), and the base prompt carries a bounded `# On-demand tools` catalog of names
and one-line descriptions, never deferred parameter schemas. The model calls
`ToolSearch` with a name or short capability query; the sidecar ranks matches,
activates at most four, returns them in `addedToolNames`, and rebuilds the context
before the next request, where native deferred-tool search may serialize the new
schemas while other adapters get them through the ordinary tool list. The deferred
set is cleared at every user prompt and rebuilt from successful activation evidence
in effective context, restored only for names still in the mode's catalog, and the
marker stays in the persisted tool result so a restarted runtime reuses an eligible
capability. `ToolSearch` never calls host-core and bypasses no permission,
workspace containment, timeout, or audit rule.

## Consequences

- Simple first turns stop paying for every optional schema, while core coding
  workflows need no discovery call.
- An ancillary capability costs one explicit `ToolSearch` turn, visible and durable
  as a normal tool activity row.
- Provider compatibility stays centralized in pi-ai: native search is an
  optimization, the active-context fallback covers every adapter.

## Alternatives

- Send every schema on every request: wastes first-turn context and grows with the
  registry.
- Activate from a prompt-text heuristic: wording is no capability classifier, and a
  miss hides a valid tool.
