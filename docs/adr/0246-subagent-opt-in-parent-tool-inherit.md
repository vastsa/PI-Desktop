# ADR 0246: Opt-in subagent inheritance of the parent tool catalog

- Status: Accepted
- Date: 2026-09-14
- Deciders: PI-Desktop core
- Related: ADR 0062, ADR 0089, ADR 0100, D201, D415, issue #215, PR #319

## Context

ADR 0062 made a subagent a bounded worker: it could only receive tools from
`SUBAGENT_ASSIGNABLE_TOOLS` (Read, Glob, Grep, BrowserPreview, Bash, Edit,
Write). Plugin tools, `Skill`, `ToolSearch`, mode tools, and `Task` were out of
reach on purpose so a definition remained the place a reader could see what a
delegate may do.

## Decision

1. Frontmatter may opt a definition into parent-tool inheritance:

   ```yaml
   tools: inherit
   # or
   tools: [inherit, Bash]
   ```

`inherit` sets `SubagentDefinition.inheritTools`. Extra names still have to be
on `SUBAGENT_ASSIGNABLE_TOOLS`.

2. At `Task` spawn, `resolveSubagentToolNames` unions the session runtime's
   **live `toolCatalog` keys** (including deferred plugin/MCP tools the parent
   is allowed to call) with any declared extras, then drops
   `SUBAGENT_INHERIT_DENY_TOOLS`:

   | Never inherited | Why |
   |---|---|
   | `Task` / `TaskWait` / `TaskList` / `TaskStop` | no nested fan-out |
   | `EnterPlanMode` / `EnterGoalMode` | mode stays the parent's |
   | `asktool` | a delegate has no user |
   | `new_context` | compaction is a parent-runtime flag |
   | `ToolSearch` | activates deferred tools on the parent catalog |

The child receives the full allowed catalog without `ToolSearch`. Inherit is
stronger than the parent's first-request active set; that is the point of
handing Skill/MCP/plugin tools to a worker.

3. Spawn-time resolved names drive the delegate tool list, mutation framing,
   search/edit/Bash guidance, and — when `Skill` is present — the same `#
   Skills` catalog the parent already received.

4. host-core's user-subagent scanner keeps the `inherit` token in `tools` so
   `tools: inherit` alone still appears in `agents.active` and round-trips
   through Settings.

5. Default documents that omit `tools` stay read-only (`Read, Glob, Grep`).

## Consequences

- A user-owned worker can call Skill/MCP/plugin tools the parent already had,
  without turning explorer into a nested Agent.
- Inherit of Bash/Edit/Write is inheriting mutation.
- Definitions remain the readable grant: `tools: inherit` is visible in the
  Markdown and in Settings.
- Child `ToolSearch` / `new_context` cannot mutate parent runtime state.

## Alternatives considered

- **Always inherit for user agents, never for builtins.** Rejected as a hidden
  default.
- **Inherit only currently active tools.** Rejected because MCP/plugin tools are
  deferred behind `ToolSearch`; a worker would still lack the catalog the issue
  asked for, and inheriting `ToolSearch` would activate tools on the parent.
- **Add `Skill` to `SUBAGENT_ASSIGNABLE_TOOLS` only.** Rejected: no MCP/plugin
  tools, still a second catalog.
