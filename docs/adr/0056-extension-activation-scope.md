# ADR 0056: User-owned MCP servers and skills, with a shared activation scope

- Status: Accepted (capability storage and UI portions superseded by ADR 0112)
- Date: 2026-08-05
- Related: ADR 0038, ADR 0039, ADR 0112, D015, D174, D192, D193, D194

## Context

Adding an MCP server or a skill meant writing a plugin, through the `mcp` point of
ADR 0038 or the `skills` point of ADR 0039 / D174. That is the wrong shape for a
JSON `mcpServers` snippet or a single Markdown document. Reach was the second gap:
`enabled` was one boolean per plugin, so an extension was on everywhere or
nowhere, and toggling by hand when switching projects left tools visible that the
model still tried to call.

## Decision

### 1. One activation shape for all three extension kinds

`packages/shared/src/activation.ts` defines
`ActivationScope = { mode: "global" | "projects"; projects: string[] }`, stored
alongside `enabled: boolean` rather than encoded into it, so plugins, user MCP
servers, and user skills share one control and one predicate. The UI three-state
control (`off` / `projects` / `global`) is derived by `activationState`, which lets
a user narrow an extension, switch it off, and switch it back on without
re-picking projects.

`isActiveInProject` is the single matching rule: comparison is case-insensitive
and trailing-separator-insensitive, a scoped path also matches its
subdirectories, a `projects`-mode extension is inactive in a session with no
project, and a missing or unrecognized scope reads as global.
`normalizeProjectPath` mirrors host-core's `normalize_project_path` so a path
chosen in the picker compares equal to the `projects` table.

### 2. Scope is enforced at catalog assembly and at dispatch

A session outlives the prompt that listed its tools, so every surface checks
twice. Plugin tools, skills, and commands filter the per-turn catalog through
`pluginActiveInProject` and re-check in `tools.execute`, the command palette, and
command execution. User MCP tools filter through
`UserMcpRuntime.toolsForProject`, and `callTool` refuses with `TOOL_NOT_FOUND`
once the record no longer applies. User skills filter through `skills.active`, and
`loadUserSkillBody` re-reads the record and throws when the scope narrowed. Themes
stay unscoped because appearance is app-wide. Agent-facing surfaces filter on the
session's `projectPath`; app-facing surfaces filter on the active window's
project.

### 3. User MCP servers are a host-core registry, not plugins

`crates/host-core/src/mcp_servers.rs` owns `McpServerRecord` files under
`~/.agents/servers` or `<project>/.agents/servers`, with activation state in
app-local `<data>/agent-capabilities/mcp.json`, exposed as `mcp.list`,
`mcp.active`, `mcp.upsert`, `mcp.remove`, and `mcp.setEnabled`. Electron main owns
the processes in `UserMcpRuntime`, reusing the plugin bridge's `McpServerClient`:
a server connects when a session that can see it is assembled, a failed handshake
stays failed until the user edits or tests it, and an edit that changes transport,
command, args, env, url, or headers drops the connection while label,
description, or scope do not. Tool names carry the `mcp_` prefix
(`userMcpToolName`), distinct from the bridge's `plugin_`, so an audit line names
the registry that served a call. `commandPolicy` is `trusted` with the child's cwd
in the user's home directory, because no plugin owns the server; spawn-time
resolution of `npx` and `uvx` is shared with the plugin bridge (ADR 0038 / D624).

### 4. A pasted `mcpServers` block is the primary way to add one

`parseMcpImport` in `packages/shared` accepts the `mcpServers` document, the
`servers` spelling, a bare map, or a single server object; it infers `http` from a
`url`, coerces non-string env and header values, honours `disabled: true`, and
caps one import. A malformed entry is reported per entry rather than failing the
whole paste.

### 5. User skills are one Markdown document each

`crates/host-core/src/user_skills.rs` scans Markdown under `~/.agents/skills` or
`<project>/.agents/skills`, with activation state in app-local
`<data>/agent-capabilities/skills.json` and RPCs `skills.list`, `skills.active`,
`skills.create`, `skills.import`, `skills.update`, `skills.read`, `skills.remove`,
and `skills.setEnabled`. D174's delivery contract is unchanged: only the
description enters the prompt, the body arrives when the model invokes `Skill`,
and the editor therefore requires a description above the body. User skill ids are
bare while plugin skill ids contain `/`, so `loadUserSkillBody` rejects a slash and
falls through to the plugin catalog.

## Consequences

- Adding an MCP server is a paste and writing a skill is Markdown; neither needs a
  manifest, package, or signature.
- An absent scope reads as global, so existing plugins need no migration and
  `SCHEMA_VERSION` is unchanged.
- Capability management is three independent Settings > Agent pages while
  Extensions keeps its installed and market tabs, and two registries live as
  hand-editable JSON outside SQLite.
- A project-scoped extension contributes nothing to a session with no workspace,
  which is intended but can surprise a user once.

## Alternatives

- Keep requiring a plugin wrapper: prices a JSON snippet and a Markdown file at
  the cost of publishing software.
- Encode "off" as a third mode: `mode: "off"` would still carry the project list,
  and consumers would have to remember it stays meaningful.
- Filter only the catalog: a session assembled before re-scoping still remembers
  the tool name, so the gap before the next prompt stays open.
