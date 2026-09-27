# ADR 0056: User-owned MCP servers and skills, with a shared activation scope

- Status: Accepted (capability storage and UI portions superseded by ADR 0112)
- Date: 2026-08-05

## Context

Until now the only way to add an MCP server or a skill to PI-Desktop was to
write a plugin. ADR 0038 gave plugins an `mcp` contribution point that Electron
main bridges over stdio or HTTP; ADR 0039 (as revised by D174) gave them a
`skills` contribution point that publishes model-invoked catalog entries behind
the `Skill` tool. Both work, and both are the wrong shape for what users
actually want to do:

- Every MCP server in the wild is distributed as a JSON snippet — a
  `mcpServers` block from a README. Asking a user to author a manifest, a
  package and a signature to run three lines of JSON is a wrapper around
  nothing.
- A skill is one Markdown document. The plugin path made the smallest possible
  extension carry the largest possible envelope.

The second gap is reach. `enabled` was a single boolean per plugin, so a plugin
was on everywhere or nowhere. A user with a work monorepo and a personal
project has extensions that belong to exactly one of them: a Jira MCP server has
no business in a session about a side project, and its tool descriptions still
cost context in every turn there. The workaround — toggling extensions by hand
when switching projects — is both tedious and easy to forget, and forgetting
leaves tools visible that the model will try to call.

## Decision

### 1. One activation shape for all three extension kinds

`packages/shared/src/activation.ts` defines
`ActivationScope = { mode: "global" | "projects"; projects: string[] }`, stored
**alongside** `enabled: boolean` rather than encoded into it. Plugins, user MCP
servers and user skills all carry the pair, so one control renders all three and
one predicate filters all three.

The three-state control the UI shows (`off` / `projects` / `global`) is derived
by `activationState`, not stored. Keeping `enabled` separate is what lets a user
narrow an extension to two projects, switch it off, and switch it back on
without re-picking the projects.

`isActiveInProject` is the single matching rule:

- Path comparison is case-insensitive and trailing-separator-insensitive,
  because macOS and Windows both hand us case-varying spellings of one
  directory, and a scope that silently stops matching reads as a bug.
- A scoped path also matches its subdirectories, so scoping to a monorepo root
  covers sessions opened on a package inside it.
- A `projects`-mode extension is **inactive** in a session with no project at
  all. "These projects" is a statement about projects; a session with no
  workspace is not one of them.
- A missing or unrecognized scope resolves to global, which is what every
  extension installed before this change was.

`normalizeProjectPath` mirrors host-core's `normalize_project_path`, so a path
chosen in the picker compares equal to the one recorded in the `projects` table.

### 2. Scope is enforced at catalog assembly **and** at dispatch

Filtering the catalog is not sufficient: a session outlives the prompt that
listed its tools, so re-scoping an extension mid-session has to take effect
immediately. Every surface therefore checks twice:

- Plugin tools, skills and commands: `pluginActiveInProject` filters the
  per-turn catalog and re-checks in `tools.execute`, in the command palette, and
  in command execution.
- User MCP tools: `UserMcpRuntime.toolsForProject` filters, and `callTool`
  refuses with `TOOL_NOT_FOUND` and "not active for this session" when the
  record no longer applies.
- User skills: `skills.active` filters, and `loadUserSkillBody` re-reads the
  record and throws if the scope has narrowed.

Themes are deliberately **not** scoped: appearance is an app-wide preference,
not a per-project capability.

Two different "current projects" exist and are not interchangeable.
Agent-facing surfaces filter on the **session's** `projectPath`; app-facing
surfaces (palette, commands, the Extensions page) filter on the **active
window's** project.

### 3. User MCP servers are a host-core registry, not plugins

`crates/host-core/src/mcp_servers.rs` owns one `McpServerRecord` JSON file
under `~/.agents/servers` or `<project>/.agents/servers`, minus the plugin.
Activation state is app-local under `<data>/agent-capabilities/mcp.json`.
The level-aware RPCs are `mcp.list`, `mcp.active`, `mcp.upsert`, `mcp.remove`,
and `mcp.setEnabled`; legacy scope-shaped inputs are compatibility fields.

Electron main owns the processes and sockets in `UserMcpRuntime`, reusing
`McpServerClient` from the plugin bridge rather than a second client:

- A server connects the first time a session that can see it is assembled, and
  its tool list is cached, so a second session on the same project costs
  nothing.
- A server that fails its handshake stays failed until the user edits it or
  presses Test, so session assembly never pays the connect timeout twice.
- Saving an edit that changes **what the server is** (transport, command, args,
  env, url, headers) drops the connection; changing label, description or scope
  does not. A stale tool list is worse than a missing one.
- The active-process cap is 16, the width the app already uses for per-owner
  resource caps; over-cap servers are logged and skipped rather than queued.
- Each server keeps the plugin bridge's own 64-tools-per-server ceiling.

Tool names get an `mcp_` prefix (`userMcpToolName`), distinct from the plugin
bridge's `plugin_`, so the two namespaces cannot collide and an audit line says
which registry served a call.

`commandPolicy` is `trusted` and the child's cwd is the user's home directory:
no plugin owns the server, so there is no plugin root to sandbox it into, and
the command the user typed is their own.

### 4. A pasted `mcpServers` block is the primary way to add one

`parseMcpImport` in `packages/shared` accepts what users actually have on the
clipboard: the `mcpServers` document, the `servers` spelling, a bare map, or a
single server object. It infers `http` from the presence of a `url` because half
the configs in the wild omit `type`; coerces non-string env and header values;
drops non-string args; honours `disabled: true`; and caps an import at 32
servers.

A malformed entry is **reported, not fatal** — the import returns what it
understood plus a per-entry reason for what it skipped, because a fifteen-server
paste with one bad entry should not be all-or-nothing.

### 5. User skills are one Markdown document each

`crates/host-core/src/user_skills.rs` scans Markdown documents under
`~/.agents/skills` or `<project>/.agents/skills`. Activation state is app-local
under `<data>/agent-capabilities/skills.json`; no registry or enabled field is
written into a skill document. RPC: `skills.list`, `skills.active`,
`skills.create`, `skills.import`, `skills.update`, `skills.read`,
`skills.remove`, and `skills.setEnabled`.

The delivery contract is D174's unchanged: the description is what enters the
prompt, the body is fetched only when the model invokes `Skill`, and a document
is capped at 128 KiB. This is why the editor requires a description and places
it above the body — the description is the part that has to earn its context
cost, and it is the only part the model sees until it asks.

User skill ids are bare; plugin skill ids contain `/`. `loadUserSkillBody`
rejects any id with a `/` and falls through to the plugin catalog, so the two
namespaces stay separable with no registry lookup.

## Consequences

- Adding an MCP server is a paste, and writing a skill is typing Markdown into
  a sheet. Neither involves a manifest, a package, or a signature.
- Plugin `enabled` semantics are unchanged for anything that never sets a
  scope, so no migration is needed: an absent scope reads as global.
- Extensions remains a two-tab (`installed`, `market`) plugin surface.
  Capability management is now three independent Settings > Agent pages;
  merging the new kinds into the installed list is still rejected.
- A project-scoped extension contributes nothing to a session with no
  workspace. That is intended, and the scope control says so, but it is a
  behaviour a user can be surprised by once.
- Two registries now live outside SQLite as JSON files. They are user-authored
  configuration that benefits from being readable and hand-editable, and
  neither needs transactions.
- `SCHEMA_VERSION` is unchanged. Plugin scopes live in the existing plugin
  record; the two new registries are files.

## Alternatives

### Keep requiring a plugin wrapper

Rejected. It is the status quo, and it prices the two most common extensions —
a JSON snippet and a Markdown file — at the cost of publishing software.

### Encode "off" as a third activation mode

Rejected. `mode: "off"` would have to carry the project list anyway to survive a
round trip through off, and every consumer would then have to remember that
`projects` is meaningful in a mode named `off`. A separate boolean says the same
thing without the trap.

### One merged "Extensions" list across all capability kinds

Rejected. Plugins are installed, MCP servers are configured, skills are
written, and subagents are global prompt documents. Their rows need genuinely
different affordances. Extensions therefore remains focused on installed
plugins and the marketplace, while Settings > Agent owns three independent
capability pages.

### Filter only the catalog, not dispatch

Rejected. A tool the model can see is a tool it will try to call, and a session
assembled before the user narrowed a scope still remembers the name. Enforcing
in one place means the window between re-scoping and the next prompt is a hole.

### Scope by session rather than by project

Rejected. Users think about extensions in terms of the codebase they are working
in, not the individual conversation, and a per-session choice would have to be
made again on every new session in the same project.

### Let a project-scoped extension apply to project-less sessions

Rejected as a "safe" default that is the opposite of safe: it would make
`projects` mode wider than it reads, and the sessions it would silently widen
into are the ones with no workspace boundary to contain them.

## References

- `packages/shared/src/activation.ts`, `packages/shared/src/mcp-import.ts`
- `packages/plugin-sdk/src/index.ts` (`userMcpToolName`)
- `crates/host-core/src/mcp_servers.rs`, `crates/host-core/src/user_skills.rs`
- `crates/host-core/src/plugins.rs`, `crates/host-core/src/rpc/mod.rs`
- `apps/desktop/electron/main/user-mcp.ts`,
  `apps/desktop/electron/main/index.ts`
- `apps/desktop/src/pages/PluginsPage.tsx`,
  `apps/desktop/src/components/extensions/*`
- `apps/desktop/src/styles/extensions.css`
- `docs/spec/07-plugins/01-plugin-system.md`,
  `docs/spec/07-plugins/03-plugin-api.md`
- Decisions D192, D193, D194; extends D015, D174, ADR 0038, ADR 0039
