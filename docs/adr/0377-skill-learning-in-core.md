# ADR 0377: Skill learning in core

- Status: Accepted
- Date: 2026-11-02
- Amends: the flat skill library and the curation pass (records not in this tree)
- Related: [ADR 0371](0371-memory-store.md), the memory-extraction design (record not in this tree)

## Context

The skill library is a core surface: `user_skills.rs` owns storage under
`~/.agents/skills`, it is a single flat global library, and a curation pass was
added on top. Sixteen `skills.*` RPCs already cover create, read, update,
import, archive, restore, curate and transfer.

What core never had was a way for the library to grow on its own. That lived in
the bundled `cn.star.skill-learning` plugin: it registered a `skill_manage`
tool, a `/learn` command, and an `agent_end` review loop that asked a model
whether a finished turn taught something reusable.

Two problems with leaving it there:

- A core capability depended on a plugin the user has to trust. Bundled plugins
  are treated as trusted at load time and skip the install-time permission
  review, so "self-improving skills" was silently running with a permission set
  nobody had approved.
- The plugin carried its own `skill-store.js` (604 lines) writing `SKILL.md`
  directly to disk, in parallel with the host's own writer. Two writers on one
  directory is a defect waiting for a race.

## Decision

Skill learning becomes a core capability. The plugin is not shipped and not
installed alongside it — one implementation, one writer.

The retirement is enforced by the bundle, not by the ADR alone:
`scripts/bundled-plugins-excluded.json` lists `cn.star.skill-learning`, so
`scripts/sync-bundled-plugins.mjs` neither fetches it into
`apps/desktop/resources/plugins` nor leaves an earlier expanded copy behind.
The plugin's source stays in the `plugins/` collection; only the bundled
artefact is gone.

The pipeline is the same passive shape as the memory-extraction design:

1. `event-persistence.ts` counts the tools a turn ran and, on either terminal
   branch, calls `scheduleSkillReview({ sessionId, usedTools, toolCallCount })`
   after the turn is already persisted.
2. `skill-review-service.ts` gates on `usedTools`, agent mode, a per-session
   cooldown and a minimum tool-call count, then runs one cheap completion with
   `SKILL_REVIEW_SYSTEM`.
3. The model answers `{ decision: "skip" | "update", reason, ops }`.
4. Ops are applied through RPCs, never through the filesystem:
   - `write_file` → `skills.writeFile`, which writes `references/<topic>.md`
     beside the skill's `SKILL.md`
   - `patch` → `skills.read` + string replacement + `skills.update`
   - `create` → `skills.create` with `shape: "dir"`, so the new skill is
     `<id>/SKILL.md` and can own references from the start

### Why the ops are ranked that way

A review that can only rewrite a whole `SKILL.md` is an all-or-nothing bet: the
model has to be confident enough to replace a large document, so it declines and
the session teaches nothing. Appending one `references/<topic>.md` costs a small
write and cannot damage existing text, which is why an incremental shape makes
the loop actually fire — the same mechanism the reference implementation uses
(an umbrella skill plus one reference per lesson).

Core already supported the directory shape on read and on import
(`<name>/SKILL.md` plus sibling resources); this ADR adds the write path so a
review can grow a skill without touching its document.

Defaults: on, minimum 3 tool calls per turn, 120 s cooldown per session,
`skillReviewAfterTurn: false` opts out. Every gate that declines a turn writes a
`skill review skipped` line with the reason, so a session that never learns is
diagnosable from the log. Every applied review ends in a toast naming the skills
it changed — a background pass the user cannot see is indistinguishable from one
that never ran.

## Consequences

- The capability ships with the app and cannot be removed by disabling a plugin,
  which is what "core" is supposed to mean. Turning it off is a setting, not an
  uninstall.
- Exactly one writer remains for `~/.agents/skills`: nothing this repository
  builds carries the plugin's `skill-store.js`. Its source stays in the
  `plugins/` collection as a market artefact.
- A skill library grown this way becomes **few umbrella skills plus many
  `references/*.md`**. That is the intended shape: `SKILL.md` stays a stable
  index, lessons accumulate beside it.
- Writing a resource to a flat `<id>.md` skill **promotes it in place** to
  `<id>/SKILL.md`. The id is the directory name in that shape, so identity is
  preserved; the flat file does not survive.
- `references/` is the only writable subtree, and `..`, absolute paths and
  non-`.md` names are rejected. A model-produced path is untrusted input.
- Core does not enforce an authoring quality bar. The plugin rejected thin
  drafts; core cannot, so the quality guide in the system prompt is the only
  lever.
- Upstream divergence: this is a core feature the upstream does not have, so it
  is a permanent conflict hotspot when merging `upstream/main`.
- The `skill_manage` tool is ported **separately**: see [ADR 0379](0379-skill-authoring-is-a-core-tool.md).
  The loop stays fully automatic, and the tool is the agent's own pen beside it
  rather than a second owner of the store.
