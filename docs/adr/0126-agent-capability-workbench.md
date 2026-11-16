# ADR 0126: Agent Capability Pages Are One Workbench That Can Author

- Status: Accepted
- Date: 2026-08-27
- Related: ADR 0063, ADR 0112, D193, D194, D202

## Context

Skills, MCP, and Subagents moved from Extensions into Settings > Agent, but the
move deleted `SkillEditorSheet.tsx` and `SubagentEditorSheet.tsx` while the host
side stayed intact, so `skills.create`, `skills.update`, `skills.read`,
`skills.reveal`, `subagents.create`, and `mcp.remove` still resolved end to end
with no renderer caller. The three pages then stacked separate Global and Project
card blocks, disabled every control while any one request was pending, and
replaced the list with skeletons after each toggle.

## Decision

1. One workbench per page. Each of Skills, MCP, and Subagents renders one toolbar
   above one panel: the toolbar owns the level filter as a segmented control with
   live counts, one search field, the project picker, and the page's primary
   actions. Level becomes a filter over one list, where each level is a group
   header row (name, resolved `.agents` path, count) and every row also carries
   its own level badge.
2. The pages author again. Create, edit, and delete return through the recovered
   editor sheets and the host calls that already existed, and new capabilities
   land at the level the filter points at. Destructive row actions sit in a
   per-row overflow menu and arm before firing. This overrides D202's fixed-height
   global list for the Subagents presentation only; subagents stay global-only,
   so that page keeps no level filter and no project picker.
3. Busy state is per row, and a refresh is not a first paint. Only the row with an
   in-flight request is busy, skeletons render on the first hydration only, and
   later loads dim the existing rows while announcing the refresh to assistive
   technology.
4. Enablement is optimistic: the switch flips locally, the host call follows, and
   the previous position returns only if the host refuses, so a toggle needs no
   reload.
5. `skills.reveal` takes the level. `revealUserSkill` and the
   `IPC.invoke.skillReveal` handler accept `{ id, level?, projectPath? }` and
   forward it to `skills.read`; a bare id string still works.

## Consequences

- Reading and managing capabilities happen in one place, and revealing a
  project-level skill now opens that project's file.
- D202's frozen page shape is superseded for presentation only; its data boundary
  (global documents under `~/.agents/subagents`, enabled state in
  `<data>/agent-capabilities/subagents.json`) is unchanged.
- An absent `maxTurns` now means unlimited rather than a hidden default, so the
  editor leaves the field empty. Renderer-only apart from the widened
  `skillReveal` payload.
