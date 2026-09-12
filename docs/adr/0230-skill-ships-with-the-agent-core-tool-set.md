# ADR 0230: Skill Ships with the Agent Core Tool Set

- Status: Accepted
- Date: 2026-09-11
- Deciders: PI-Desktop runtime maintainers
- Amends: D174, ADR 0048, ADR 0219

## Context

ADR 0048 keeps the first Agent request on a small core set and defers every
other capability behind the local `ToolSearch` tool, so a large plugin surface
cannot recreate the original prompt bloat. `Skill` was registered into that
deferred set: it only appears in the provider schema after the model searches
for it.

Two later decisions assume a `Skill` tool the model can call immediately:

- D174 makes the skill catalog the model-invoked way to load a document, and
  advertises it in the `# Skills` system-prompt section with an instruction to
  load a matching skill first.
- ADR 0219 answers a user-typed `/skill-id` by persisting an instruction to
  call the local `Skill` tool with the validated id on that turn.

Neither can be satisfied when the tool is absent from the first request's tool
list. A model that does not search for it either re-searches, calls a tool it
cannot see, or answers from the catalog line alone; a user who explicitly asked
for a skill pays one or two extra round trips before the body is ever loaded.

## Decision

1. `Skill` joins `AGENT_CORE_TOOL_NAMES`, so an Agent-mode request carries its
   schema from the first turn. Its registration gate is unchanged: the tool
   exists only when the skill catalog is non-empty, and Plan and Goal continue
   to omit it entirely.
2. The tool stays out of the deferred catalog and therefore never appears under
   `# On-demand tools`. Other on-demand capabilities (`BrowserPreview`, plugin
   tools, plugin-development helpers, and MCP tools) keep their lazy behavior,
   and `ToolSearch` is still registered whenever any of them exist.
3. No protocol, storage, permission, or skill-body change follows from this.
   Bodies still load on demand through the same local tool and its existing
   host path and permission checks.

## Consequences

- A matching task loads its skill on the first turn instead of discovering the
  tool first, and a `/skill-id` invocation works as ADR 0219 describes.
- Every Agent-mode request carries one more tool schema. The catalog is already
  bounded per session, and the delegation lifecycle was admitted to the core set
  for the same reason: a capability the model has to go looking for is one it
  will not use.
- Removing the `Skill` row from the deferred catalog also removes the only path
  that could route a skill through `ToolSearch`, so the catalog description for
  it is deleted rather than left unreachable.

## Alternatives considered

- **Keep `Skill` deferred and rely on prompting:** rejected because a tool
  absent from the schema cannot be called no matter what the system prompt says,
  which is the behavior that produced this issue.
- **Inject skill bodies into the system prompt:** rejected for the cost and
  reload semantics D174 and ADR 0039 already settled.
- **Make every on-demand tool core:** rejected because it recreates the prompt
  bloat ADR 0048 exists to prevent. Only `Skill` is admitted here.
