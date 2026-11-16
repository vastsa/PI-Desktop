# ADR 0112: Agent Capability Management Roots and Settings IA

- Status: Accepted
- Date: 2026-08-20
- Supersedes the capability-storage and capability-IA portions of ADR 0056,
  ADR 0058, and ADR 0063; updates D193, D194, and D202

## Context

MCP servers, skills, and subagent definitions were described as registries under
the application data directory and managed from the Extensions page, which made
capability files hard to carry between installations and mixed configuration
with app-local activation state.

## Decision

### 1. `.agents` is the only capability file root

The host scans and writes only `~/.agents/skills` and `<project>/.agents/skills`
for skills, `~/.agents/servers` and `<project>/.agents/servers` for MCP
configuration, and `~/.agents/subagents` for subagent definitions; there is no
project-level subagent directory, and `.pi/agents`, `.pi/skills`, and `.pi/mcp`
are not capability sources while the unrelated `.pi/prompts` store is unchanged.

### 2. File ownership and activation state are separate

Capability documents never contain `enabled` or a project override; host-core
keeps app-local state under `<data>/agent-capabilities/`, with globals enabled
by default, projects carrying their own state, and scanning pruning records for
files that no longer exist.

### 3. Project precedence is resolved before filtering

Project records shadow global records by id or case-insensitive display name
even when locally disabled, because only after shadowing does the host filter
disabled records.

### 4. Management lives under Settings > Agent

Skills, MCP, and Subagents are three independent Settings destinations rather
than tabs, and Extensions keeps only Installed and Marketplace.

### 5. Protocol queries are explicit

Capability list, read, remove, import, and enable calls carry `level` and, when
needed, `projectPath`, and a project-level request without `projectPath` is
invalid; runtime activation merges `mcp.active` and `skills.active` for the
selected project, while subagent activation is global-only.

## Consequences

- Capability files stay portable and a project can disable a global capability
  without editing the global file.
- Extensions stays a focused plugin surface and each capability page exposes
  its own affordances.
- Plugin activation scopes are unchanged, and legacy scope RPC fields survive
  only as no-op inputs.
