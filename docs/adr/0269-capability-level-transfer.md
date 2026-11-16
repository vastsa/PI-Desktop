# ADR 0269: Move capability documents between the global and project levels

- Status: Accepted for implementation
- Date: 2026-09-16
- Amends: ADR 0112 (agent capability management roots and Settings IA — adds a cross-level move to the capability surfaces)
- Related: ADR 0056 (user-owned MCP servers and skills), D193, D194

## Context

ADR 0112 made `.agents` the only capability root, with each MCP server or skill
living globally or inside a project while app-local state records enablement and
per-project overrides. The two levels were reachable only as independent lists, so
changing a capability's level meant deleting the document at one level and
recreating it at the other, which lost the enablement decision and risked the only
copy. This record covers the move that `mcp.transfer` and `skills.transfer` expose.

## Decision

### 1. A level switch moves the document; it does not copy it

The file's level is its ownership, so the source level stops listing the entry and
the destination holds the only file. `McpServerRegistry::transfer` and
`UserSkillRegistry::transfer` relocate one unit per capability, trying
`fs::rename` first for a same-filesystem move and falling back to copy-then-remove,
and always writing the destination before removing the source.

### 2. A destination collision renames the arriving document; it never blocks the move

A colliding id takes a numeric suffix and a colliding display name takes a
parenthesized one, so both definitions survive and the response returns the record
under the id it landed on. Skill placement replays the catalog's own
`capability_id` for each candidate path and resolves the arrived record by path,
because a skill's identity comes from its frontmatter name rather than its file
name.

### 3. Activation state follows the document

`set_moved_capability_state` drops the source level's state, including every
project override, and writes the value the source row showed at the destination;
moving into global stores a new global default rather than another project's
override.

### 4. The two ends are explicit and a same-directory move is a no-op

`mcp.transfer` and `skills.transfer` take `{ id, from, to }`, each end a
`{ level, projectPath? }` target, a project-level end without `projectPath` fails
with `CAPABILITY_INVALID`, and `CapabilityTarget::same_directory` makes a
same-directory move return the current record unchanged.

### 5. The global `.agents` root has a redirect seam

`PI_DESKTOP_AGENTS_DIR` repoints the global capability root the way
`PI_DESKTOP_DATA_DIR` repoints the data directory, falling back to the home
directory when empty, so the cross-level move is testable and portable without
touching the user's own `~/.agents`. It is a test and installation seam, not a
user setting.

## Consequences

- A capability has exactly one home, so the Settings row disappears from the source
  group and appears in the destination group.
- A directory skill keeps working because its resources travel with the document,
  and a collision leaves two definitions the user can tell apart.
- The move is host-owned, `mcp.list`, `mcp.active`, `skills.list`, and
  `skills.active` report the result after the scan, and the document never carries
  `enabled`.
