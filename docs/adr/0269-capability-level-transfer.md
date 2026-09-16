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
levels were reachable only as two independent lists. Changing a capability's
level therefore meant deleting the file at one level and recreating it at the
other: the user had to retype the document, the enablement decision was lost,
and a mistake destroyed the only copy. Nothing in the Settings IA expressed the
switch as one action.

Users do legitimately change their mind about ownership — a scratch server
graduates from one project to every project, or a global experiment turns out to
belong to one repository. This ADR records the move that the MCP and Skill pages
now expose (`mcp.transfer` / `skills.transfer`).

## Decision

### 1. A level switch moves the document; it does not copy it

The file's level *is* its ownership. A copy would leave the source level holding
a definition the user just said belongs elsewhere, so the same capability would
appear twice with two names until the user cleaned up the old one — and the two
would drift. The source level stops listing the entry, and the destination holds
the only file.

The move is one unit per capability: `McpServerRegistry::transfer` relocates the
server's JSON file, and `UserSkillRegistry::transfer` relocates either the single
Markdown document or, for the conventional `<skill>/SKILL.md` shape, the whole
skill directory with the sibling resources a `Skill` invocation resolves
(`directory_skill_root`, `copy_directory_contents`). `move_capability_file`
tries `fs::rename` first so a same-filesystem move is atomic and cheap, and
falls back to copy-then-remove for a project on another mount. When the document
must be rewritten (the rename case below), the destination is written before the
source is removed, so an interrupted move leaves a shadowed duplicate rather
than no capability at all.

### 2. A destination collision renames the arriving document; it never blocks the move

The destination level may already own the same id, or the same display name /
label compared case-insensitively, the way project-over-global shadowing
compares it. Overwriting an existing document would be data loss, and refusing
the move would make the level switch useless whenever both sides happen to share
a name. The arriving document is therefore disambiguated the way a file manager
disambiguates a copy: a colliding id takes a `-2`/`-3`… suffix (within the
64-character id budget, `suffixed_capability_id`), and a colliding display name
takes a ` (2)`/` (3)`… suffix (`suffixed_display_name`). The existing entry and
its file stay untouched, and the RPC response returns the record under the id
it landed on so the UI can follow the rename.

Renaming a skill rewrites only the frontmatter `name` line
(`rewrite_document_name`); every other frontmatter field, the whitespace, the
line endings, and the body are copied byte for byte, because the user asked to
relocate a document, not to reformat it. A document with no parsable frontmatter
block gets a fresh one so the renamed file is still scannable.

A skill's identity is not its file name, and the move has to plan against the
scanner rather than the filesystem. The catalog derives a skill's id with
`capability_id`: the slug of the frontmatter `name` when that slug is usable,
otherwise the slug of the path stem, and a hash as a last resort. A Chinese
name, or a name whose slug already belongs to another document, therefore lands
on an id the file name does not predict. Choosing a file name first and reading
the id back from it produced exactly the failure this decision avoids: the
source file was gone while the arrival was reported missing, and a same-id
document silently lost the scan's de-duplication and vanished from Settings.
`plan_skill_placement` now replays the real `capability_id` for the exact path
each candidate would occupy, accepts only a placement the scan lists as its own
record, and `transfer` resolves the arrived record by path — never by the stem
it chose — so the state entry is written under the id the catalog will read
back. A landing the scan still refuses (an empty body, an oversized document)
is rolled back to the source with its original bytes, because no state has been
written yet and a loud error beats a stranded file.

The same reasoning makes id collisions case-insensitive: macOS and Windows both
hand back one file for `MyServer.json` and `myserver.json`, so a move that
compared ids literally would write over a definition it never listed.


One artifact of that pre-existing `capability_id` rule is accepted rather than
changed here: a non-ASCII name that has to be suffixed gains ASCII characters,
and those characters alone become its slug. A Chinese-named skill arriving
beside a same-named one therefore lands on the id `2`, not on a readable stem.
Making the slug ignore a purely numeric remainder would change how every
imported document is identified, which is a wider decision than a level move.
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

`mcp.transfer` / `skills.transfer` take `{ id, from, to }`, each end a
`{ level, projectPath? }` target, instead of a single level and an implicit
"other side": the two ends can never be derived from one another wrongly, and a
project-level end without `projectPath` fails with `CAPABILITY_INVALID`.
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
capabilities anywhere but the user's home. It is a test and installation seam,
not a user setting, and it is not exposed in Settings.

## Consequences

- A capability has exactly one home. The Settings row disappears from the source
  group and appears in the destination group, which is the confirmation the move
  happened; a same-level duplicate is impossible by construction.
- A directory skill keeps working after the move because its resources travel
  with the document; a renamed directory skill is written under its new id.
- Collisions stay productive: both definitions survive under names the user can
  tell apart, at the cost of the user having to recognize the `-2` name as the
  one they just moved.
- A moved global document drops its other projects' overrides. Those entries no
  longer name any global document, so keeping them would be state for a
  capability that does not exist; the projects simply fall back to no entry.
- The move is host-owned and does not touch the renderer's level queries:
  `mcp.list` / `mcp.active` / `skills.list` / `skills.active` report the result
  after the scan, and the document itself never carries `enabled`.
- Validation: transfer, rename, state, and directory-resource paths are covered
  by host-core registry tests, and the move-menu destination rule has a
  source-contract test in `apps/desktop/test/agent-capability-settings.test.mjs`.
  The rendered journey is specified as E2E-CAPABILITY-move-across-levels and
  remains Draft until a rendered E2E run is performed.
