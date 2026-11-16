# ADR 0063: A Managed Surface for Global Subagent Definitions

- Status: Accepted (amended by ADR 0112)
- Date: 2026-08-06
- Deciders: PI-Desktop core
- Related: D202, ADR 0062 (bounded subagents), ADR 0112

## Context

ADR 0062 shipped subagents without a renderer surface: a personal delegate meant
placing a Markdown document in an implementation-specific location. The surface must
not write tracked project files or invent a project-level source that differs from
the runtime contract.

## Decision

### 1. Global documents are the only user-managed subagent source

User definitions are `~/.agents/subagents/<id>.md`; there is no project-level
subagent directory and the application never scans or writes `.pi/agents`.
`id == name` stays the model's `Task` handle, duplicate names are rejected.

### 2. Activation is app-local

The document owns prompt metadata (`name`, `description`, `tools`, `model`,
`thinkingLevel`, `maxTurns`) but never `enabled`, which lives in
`<data>/agent-capabilities/subagents.json`; scanning removes state for deleted
documents.

### 3. The Settings page is global-only

Settings > Agent > Subagents is one fixed-height global list with no project picker
or import action; each row shows the frontmatter summary and an app-local enable
switch. Skills and MCP keep separate destinations, and Extensions holds only
Installed and Marketplace.

### 4. The runtime remains the source of truth

Electron supplies the global documents to `loadSubagentDefinitions` on the next
prompt; the renderer reimplements no precedence.

## Consequences

- Personal delegates follow the user across projects, while teams needing a
  repository-specific prompt use the project instruction mechanism.
- Enablement persists outside the Markdown, and project precedence applies to Skills
  and MCP only.
