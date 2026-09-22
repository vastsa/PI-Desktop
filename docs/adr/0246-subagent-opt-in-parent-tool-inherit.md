# ADR 0246: Opt-in subagent inheritance of the parent tool catalog

- Status: Accepted
- Date: 2026-09-14
- Deciders: PI-Desktop core
- Related: ADR 0062, ADR 0089, ADR 0100, D201, D415, issue #215, PR #319

## Context

ADR 0062 made a subagent a bounded worker: it could only receive tools from
`SUBAGENT_ASSIGNABLE_TOOLS` (read, glob, grep, browser_preview, bash, edit,
write). Plugin tools, `skill`, `tool_search`, mode tools, and `task` were out of
reach on purpose so a definition remained the place a reader could see what a
delegate may do.

Permission mode (`permission: inherit`) and the session model (empty `model`
pin) already follow the parent. Tool capability did not. A parent that had
loaded `skill`, MCP, or plugin tools could not give any of that to a worker it
just spawned. Builtins that stay on today's whitelist (explorer, code-reviewer)
are still the right default; user-defined workers that *should* share the
parent catalog had no opt-in.

Always inheriting would make every delegation as dangerous as the session.
Putting `skill` alone on the assignable list would still leave MCP and plugin
tools as a second catalog.

## Decision

1. Frontmatter may opt a definition into parent-tool inheritance:

   ```yaml
   tools: inherit
   # or
   tools: [inherit, bash]
   ```

   `inherit` sets `SubagentDefinition.inheritTools`. Extra names still have to
   be on `SUBAGENT_ASSIGNABLE_TOOLS`. Builtins do not opt in.

2. At `task` spawn, `resolveSubagentToolNames` unions the session runtime's
   **live `toolCatalog` keys** (including deferred plugin/MCP tools the parent
   is allowed to call) with any declared extras, then drops
   `SUBAGENT_INHERIT_DENY_TOOLS`:

   | Never inherited | Why |
   |---|---|
   | `task` / `task_wait` / `task_list` / `task_stop` | no nested fan-out |
   | `enter_plan_mode` / `enter_goal_mode` | mode stays the parent's |
   | `asktool` | a delegate has no user |
   | `new_context` | compaction is a parent-runtime flag |
   | `tool_search` | activates deferred tools on the parent catalog |

   The child receives the full allowed catalog without `tool_search`. Inherit
   is stronger than the parent's first-request active set; that is the point
   of handing skill/MCP/plugin tools to a worker.

3. Spawn-time resolved names drive the delegate tool list, mutation framing,
   search/edit/bash guidance, and — when `skill` is present — the same
   `# Skills` catalog the parent already received. The task catalog prints
   `inherit` (plus extras) rather than dumping every MCP name.

4. host-core's user-subagent scanner keeps the `inherit` token in `tools` so
   `tools: inherit` alone still appears in `agents.active` and round-trips
   through Settings. The editor exposes an inherit checkbox; saving must not
   strip the token.

5. Default documents that omit `tools` stay read-only (`read, glob, grep`).
   `tools: "*"` still means the seven assignable tools, not the session
   catalog. A session cannot lend mutation to a read-only delegate unless that
   definition opted into inherit.

This amends ADR 0062 §2 and the rejected alternative "Let delegates inherit
the parent's tools": inherit is now an explicit document opt-in with a deny
list, not silent session equality.

## Consequences

- A user-owned worker can call skill/MCP/plugin tools the parent already had,
  without turning explorer into a nested Agent.
- Inherit of bash/edit/write is inheriting mutation. Permission mode and the
  external-path gate are unchanged; `permission: inherit` still follows the
  session.
- Definitions remain the readable grant: `tools: inherit` is visible in the
  Markdown and in Settings.
- Child `tool_search` / `new_context` cannot mutate parent runtime state.

## Alternatives considered

- **Always inherit for user agents, never for builtins.** Rejected as a hidden
  default. Markdown opt-in is the same shape as `permission: inherit`.
- **Inherit only currently active tools.** Rejected because MCP/plugin tools
  are deferred behind `tool_search`; a worker would still lack the catalog the
  issue asked for, and inheriting `tool_search` would activate tools on the
  parent.
- **Add `skill` to `SUBAGENT_ASSIGNABLE_TOOLS` only.** Rejected: no MCP/plugin
  tools, still a second catalog.
