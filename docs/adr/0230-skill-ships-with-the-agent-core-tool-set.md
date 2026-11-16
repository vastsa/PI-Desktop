# ADR 0230: Skill Ships with the Agent Core Tool Set

- Status: Accepted
- Date: 2026-09-11
- Deciders: PI-Desktop runtime maintainers
- Amends: D174, ADR 0048, ADR 0219

## Context

As originally accepted, ADR 0048 kept the first Agent request on a small core
set and deferred optional capabilities behind the local `ToolSearch` tool, so a
large plugin surface could not recreate the original prompt bloat. `Skill` was
registered into that deferred set: it only appeared in the provider schema after
the model searched for it.

- D174 makes the skill catalog the model-invoked way to load a document, and
  advertises it in the `# Skills` system-prompt section with an instruction to
  load a matching skill first.
- ADR 0219 answers a user-typed `/skill:<skill-id>` by persisting an instruction
  to call the local `Skill` tool with the validated id on that turn.

## Decision

1. `Skill` joins `AGENT_CORE_TOOL_NAMES`, so an Agent-mode request carries its
   schema from the first turn.
2. The tool stays out of the deferred catalog and therefore never appears under
   `# On-demand tools`.
3. No protocol, storage, permission, or skill-body change follows from this.

## Consequences

- A matching task loads its skill on the first turn instead of discovering the
  tool first, and a `/skill:<skill-id>` invocation works as ADR 0219 describes.
- Every Agent-mode request carries one more tool schema.
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
  bloat ADR 0048 exists to prevent.

## Amendment — 2026-09-27: Agent search tools start active

The amendment to ADR 0048 also places `Glob` and `Grep` in the first Agent
request to remove the discovery round trip for routine workspace exploration.
This does not change ADR 0230: `Skill` remains core when its catalog exists, and
plugin, preview, and development tools remain deferred.
