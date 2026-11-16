# ADR 0230: Skill Ships with the Agent Core Tool Set

- Status: Accepted
- Date: 2026-09-11
- Amends: D174, ADR 0048, ADR 0219

## Context

ADR 0048 kept the first Agent request on a small core set and deferred optional
capabilities behind `ToolSearch`, and `Skill` sat in that deferred set. Two later
decisions assume a `Skill` tool the model can call immediately: D174 advertises the
skill catalog in the `# Skills` system-prompt section, and ADR 0219 answers a
typed `/skill:<skill-id>` by persisting an instruction to call the local `Skill`
tool. Neither works when the tool is absent from the first request, so the model
re-searches, calls a tool it cannot see, or answers from the catalog line alone.

## Decision

1. `Skill` joins `AGENT_CORE_TOOL_NAMES`, so an Agent-mode request carries its
   schema from the first turn. Its registration gate is unchanged: the tool exists
   only when the skill catalog is non-empty, and Plan and Goal still omit it.
2. The tool leaves the deferred catalog and never appears under
   `# On-demand tools`. Other on-demand capabilities (`BrowserPreview`, plugin
   tools, plugin-development helpers, MCP tools) keep their lazy behavior, and
   `ToolSearch` stays registered whenever any of them exist.
3. No protocol, storage, permission, or skill-body change follows. Bodies still
   load on demand through the same tool, host path, and permission checks.

## Consequences

- A matching task loads its skill on the first turn and `/skill:<skill-id>` works
  as ADR 0219 describes.
- Every Agent-mode request carries one more tool schema; the catalog is already
  bounded per session, and a capability the model must go looking for is one it
  will not use.
- The `ToolSearch` catalog row for `Skill` is deleted rather than left
  unreachable.

## Amendment — 2026-09-27: Agent search tools start active

The amendment to ADR 0048 also places `Glob` and `Grep` in the first Agent request
to remove the discovery round trip for routine exploration. This does not change
this record: `Skill` remains core while its catalog exists, and plugin, preview,
and development tools remain deferred.
