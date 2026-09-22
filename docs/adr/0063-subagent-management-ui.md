# ADR 0063: A Managed Surface for Global Subagent Definitions

- Status: Accepted (amended by ADR 0112)
- Date: 2026-08-06
- Deciders: PI-Desktop core
- Related: D202, ADR 0062 (bounded subagents), ADR 0112

## Context

ADR 0062 shipped subagents without a renderer surface. A user could create a
personal delegate only by placing a Markdown document in an implementation-
specific location, and the shipped catalog was not visible in Settings. The
management surface must not write tracked project files or silently introduce a
project-level source that differs from the runtime contract.

## Decision

### 1. Global documents are the only user-managed subagent source

User-owned definitions are Markdown files in:

```text
~/.agents/subagents/<id>.md
```

There is no project-level subagent directory. The application does not scan or
write `.pi/agents` for capability management. `id == name` remains the model's
`task` handle, duplicate names are rejected, and the runtime's global user
catalog is combined with the builtins without a project capability layer.

### 2. Activation is app-local

The document owns prompt metadata (`name`, `description`, `tools`, `model`,
`thinkingLevel`, and `maxTurns`) but never owns `enabled`. The enabled state is
stored in `<data>/agent-capabilities/subagents.json`. Scanning the global
folder removes state for deleted documents, so a missing file never leaves a
visible pending row or an orphaned override.

### 3. The Settings page is global-only

Settings > Agent > Subagents is one fixed-height global list. It has no project
picker, project column, or add/import action in this surface. Each row shows the
frontmatter summary and a local enable switch; toggling it writes only the
app-local state file and takes effect on the next runtime catalog load.

Skills and MCP have separate Settings destinations and are not tabs inside
Extensions. Extensions itself contains only Installed and Marketplace.

### 4. The runtime remains the source of truth

Electron supplies the global user documents to `loadSubagentDefinitions` on the
next prompt. The renderer does not reimplement catalog precedence or invent a
project source. Builtins and malformed documents are handled by the runtime
loader; the management list is the scanned global user-document list.

## Consequences

- Personal delegates follow the user across projects without modifying a
  repository.
- Teams that need a repository-specific prompt must use the project's normal
  instruction mechanism; `.pi/agents` is not a capability source.
- The UI can show and persist local enablement without changing Markdown files.
- There is no project-scoped subagent toggle, so project precedence applies to
  Skills and MCP only.
