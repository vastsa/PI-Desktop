# ADR 0112: Agent Capability Management Roots and Settings IA

- Status: Accepted
- Date: 2026-08-20
- Deciders: PI-Desktop core
- Supersedes the capability-storage and capability-IA portions of ADR 0056,
  ADR 0058, and ADR 0063; updates D193, D194, and D202

## Context

MCP servers, skills, and subagent definitions were previously described as
registries under the application data directory, and the Extensions page grew
to contain their management surfaces. That model made capability files hard to
carry between installations, mixed configuration with app-local activation
state, and made the Extensions page responsible for unrelated authoring flows.
It also left several documents referring to `.pi/` capability directories.

## Decision

### 1. `.agents` is the only capability file root

The host scans and writes only these directories:

```text
~/.agents/skills                 global skills
<project>/.agents/skills         project skills
~/.agents/servers                global MCP configuration
<project>/.agents/servers        project MCP configuration
~/.agents/subagents              global subagent definitions
```

There is no project-level subagent directory. `.pi/agents`, `.pi/skills`, and
`.pi/mcp` are not capability sources; the unrelated `.pi/prompts` store is
unchanged.

Skills are Markdown documents. Their `name` and `description` frontmatter are
scanned into the catalog while the body remains on disk until the `skill` tool
needs it. MCP servers are one JSON file per id. Subagents are Markdown
Documents with the frontmatter consumed by the runtime.

### 2. File ownership and activation state are separate

Capability documents never contain `enabled` or a project override. host-core
stores app-local state in:

```text
<data>/agent-capabilities/skills.json
<data>/agent-capabilities/mcp.json
<data>/agent-capabilities/subagents.json
```

Global capabilities default to enabled and may have a per-project override.
Project capabilities have state for their owning project. Scanning a directory
prunes state for files that no longer exist; removing a global file removes all
of its project overrides, while a project scan only removes that project's
orphaned entries.

### 3. Project precedence is resolved before filtering

For the active runtime, project records shadow global records by id or
case-insensitive display name. The project record wins even when its local
state is disabled; only after shadowing does the host filter disabled records.
This prevents a disabled project definition from making the global definition
visible again.

### 4. Management lives under Settings > Agent

Skills, MCP, and Subagents are three independent Settings destinations, not tabs.
Skills and MCP use fixed-height global/project columns; their project column has
a recent-project picker. Subagents use one global column and no project picker.
The Extensions destination keeps only Installed and Marketplace tabs.

Skills expose one single-file native import action per column and physically copy
the selected document into that column's `.agents/skills` directory. MCP create
and edit reuse `McpEditorSheet`; editing locks the id, validation is shared with
the host, and same-level id or label duplicates are rejected. Testing a saved
MCP connection reports the result in the editor and a toast.

### 5. Protocol queries are explicit

Capability list, read, remove, import, and enable calls carry `level` and,
when needed, `projectPath`. A project-level request without `projectPath` is
invalid. Runtime activation uses the merged `mcp.active` and `skills.active`
results for the selected project; subagent activation is global-only.

## Consequences

- Capability files are portable, inspectable, and safe to share without copying
  application-local enablement decisions.
- A project can override or disable a global capability without changing the
  global file.
- The Settings IA is larger, but Extensions is a focused plugin/marketplace
  surface and every capability page can expose its own affordances.
- Existing plugin activation scopes remain unchanged; they are not reused for
  the file-level capability pages.
- The host retains compatibility-shaped legacy scope RPC fields as no-op
  inputs where needed, but new UI state is represented by level and local state.
