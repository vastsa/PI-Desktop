# ADR 0269: Move capability documents between the global and project levels

- Status: Accepted for implementation
- Date: 2026-09-16
- Amends: ADR 0112 (agent capability management roots and Settings IA — adds a
  cross-level move to the capability surfaces)
- Related: ADR 0056 (user-owned MCP servers and skills), D193, D194

## Context

ADR 0112 made `.agents` the only capability root and separated file ownership
from app-local activation state: an MCP server or skill lives globally
(`~/.agents/servers`, `~/.agents/skills`) or inside a project
(`<project>/.agents/...`), while `<data>/agent-capabilities/*.json` records
whether it is enabled, with a per-project override for global documents. The two
levels were reachable only as two independent lists.

## Decision

### 1. A level switch moves the document; it does not copy it

The file's level *is* its ownership. A copy would leave the source level holding
a definition the user just said belongs elsewhere, so the same capability would
appear twice with two names until the user cleaned up the old one — and the two
would drift.

The move is one unit per capability: `McpServerRegistry::transfer` relocates the
server's JSON file, and `UserSkillRegistry::transfer` relocates either the
single Markdown document or, for the conventional `<skill>/SKILL.md` shape, the
whole skill directory with the sibling resources a `Skill` invocation resolves
(`directory_skill_root`, `copy_directory_contents`). `move_capability_file`
tries `fs::rename` first so a same-filesystem move is atomic and cheap, and
falls back to copy-then-remove for a project on another mount.

### 2. A destination collision renames the arriving document; it never blocks the move

The destination level may already own the same id, or the same display name /
label compared case-insensitively, the way project-over-global shadowing
compares it. Overwriting an existing document would be data loss, and refusing
the move would make the level switch useless whenever both sides happen to share
a name.

Renaming a skill rewrites only the frontmatter `name` line
(`rewrite_document_name`); every other frontmatter field, the whitespace, the
line endings, and the body are copied byte for byte, because the user asked to
relocate a document, not to reformat it. A document with no parsable frontmatter
block gets a fresh one so the renamed file is still scannable.

### 3. Activation state follows the document

State is app-local and ownership-free, so a move that left the old enablement
behind would silently change whether the capability runs, and a move that left
entries at the source level would leave pointers to an id that no longer exists
there. `set_moved_capability_state` therefore drops the source level's state for
the old id — via `CapabilityState::forget`, including every project override a
moved global document had — and writes the value the source row was showing at
the destination:

- moving into a project stores that project's own state;
- moving into global stores that value as the new global default, never another
  project's override, because the move says nothing about the projects the
  document left behind.

A global source read may carry a `projectPath`, which is exactly the context the
visible value is resolved in; `CapabilityTarget` keeps that field so the two
meanings — "owner" and "state context" — are never confused.

### 4. The two ends are explicit and a same-directory move is a no-op

`mcp.transfer` / `skills.transfer` take `{ id, from, to }`, each end a `{ level,
projectPath? }` target, instead of a single level and an implicit "other side":
the two ends can never be derived from one another wrongly, and a project-level
end without `projectPath` fails with `CAPABILITY_INVALID`.
`CapabilityTarget::same_directory` makes a move whose ends name the same
directory a no-op that returns the current record, so a UI that offers the
action redundantly can never rewrite the file.

### 5. The global `.agents` root has a redirect seam

`PI_DESKTOP_AGENTS_DIR` repoints the global capability root, the way
`PI_DESKTOP_DATA_DIR` repoints the app-local data directory; an empty value
falls back to the home directory (`AGENTS_DIR_ENV`, `global_agents_dir`). A
cross-level move spans the real home directory and a project, so without the
seam the global half of the feature can only be tested against the developer's
own `~/.agents`, and an isolated or portable install cannot place its global
capabilities anywhere but the user's home.

## Consequences

- A capability has exactly one home.
- A directory skill keeps working after the move because its resources travel
  with the document; a renamed directory skill is written under its new id.
- Collisions stay productive: both definitions survive under names the user can
  tell apart, at the cost of the user having to recognize the `-2` name as the
  one they just moved.
- A moved global document drops its other projects' overrides.
- The move is host-owned and does not touch the renderer's level queries:
  `mcp.list` / `mcp.active` / `skills.list` / `skills.active` report the result
  after the scan, and the document itself never carries `enabled`.
