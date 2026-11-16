# ADR 0246: Opt-in subagent inheritance of the parent tool catalog

- Status: Accepted
- Date: 2026-09-14
- Related: ADR 0062, ADR 0089, ADR 0100, D201, D415, issue #215, PR #319

## Context

ADR 0062 made a subagent a bounded worker limited to
`SUBAGENT_ASSIGNABLE_TOOLS`, deliberately excluding plugin tools, `Skill`,
`ToolSearch`, mode tools, and `Task`. Permission mode and the model pin already
follow the parent, but tool capability did not, so a parent holding `Skill`, MCP,
or plugin tools could not share them with a worker it spawned, and always
inheriting would make every delegation as dangerous as the session.

## Decision

1. Frontmatter may opt a definition in with `tools: inherit` or
   `tools: [inherit, Bash]`. `inherit` sets `SubagentDefinition.inheritTools`, any
   extra name must still be assignable, and builtins do not opt in.
2. At `Task` spawn, `resolveSubagentToolNames` unions the session runtime's live
   `toolCatalog` keys, including deferred plugin and MCP tools, with declared
   extras and drops `SUBAGENT_INHERIT_DENY_TOOLS`: `Task`, `TaskWait`, `TaskList`,
   and `TaskStop` (no nested fan-out), `EnterPlanMode` and `EnterGoalMode` (mode
   stays the parent's), `asktool` (a delegate has no user), `new_context`
   (compaction is a parent flag), and `ToolSearch` (it activates tools on the
   parent catalog). The child receives the allowed catalog without `ToolSearch`,
   and inherit is deliberately stronger than the parent's first-request set.
3. Spawn-time names drive the delegate tool list, mutation framing,
   search/edit/Bash guidance, and, when `Skill` is present, the same `# Skills`
   catalog the parent received; the Task catalog prints `inherit` plus extras
   instead of listing every MCP name.
4. host-core's user-subagent scanner keeps the `inherit` token in `tools` so a
   `tools: inherit`-only definition still appears in `agents.active` and
   round-trips through Settings without the editor stripping it.
5. Documents that omit `tools` stay read-only (`Read, Glob, Grep`), and `tools:
   "*"` still means the assignable tools rather than the session catalog.

This amends ADR 0062 §2 and its rejected "let delegates inherit the parent's
tools" alternative: inherit is now an explicit document opt-in with a deny list.

## Consequences

- A user-owned worker can call Skill, MCP, and plugin tools the parent already
  had, without turning builtins into nested agents.
- Inheriting Bash, Edit, or Write inherits mutation; permission mode and the
  external-path gate are unchanged.
- The grant stays readable in Markdown and Settings, and a child cannot mutate
  parent runtime state through `ToolSearch` or `new_context`.

## Alternatives

- Always inherit for user agents: rejected as a hidden default where Markdown
  opt-in matches `permission: inherit`.
- Add `Skill` to the assignable list only: rejected because it leaves MCP and
  plugin tools as a second catalog.
