# ADR 0126: Agent Capability Pages Are One Workbench That Can Author

- Status: Accepted
- Date: 2026-08-27
- Related: ADR 0063, ADR 0112, D193, D194, D202
- Baseline: `0.10.8`

## Context

`d24e1ee0` moved Skills, MCP, and Subagents out of Extensions and into
Settings > Agent. The move carried the list and the enablement switch, but it
deleted `SkillEditorSheet.tsx` and `SubagentEditorSheet.tsx` along the way. The
host side was never reduced: `skills.create`, `skills.update`, `skills.remove`,
`skills.read`, `skills.reveal`, `subagents.create`, `subagents.update`,
`subagents.remove`, and `mcp.remove` all still resolve end to end through
`api.ts` and `rpc/mod.rs`. Only the renderer stopped calling them.

Three problems followed from the shape the pages were left in:

1. **The level was structure, not a filter.** Each page stacked a Global card
   block and a Project card block, each with its own heading, its own resolved
   path, its own count, and its own actions. A page with four skills spent most
   of its height on two headers, and the project picker was reachable only
   inside the second block, below the first list.
2. **One pending request locked the page.** Rows were rendered with
   `busy={loading || busyKey !== null}` and `disabled={loading || busyKey !==
   null}`, so toggling any one capability disabled every control on the page,
   including the unrelated level's rows.
3. **A toggle flashed the skeletons.** `toggle()` awaited `load()` on success,
   and `load()` set `loading` unconditionally, so a switch replaced the whole
   list with skeleton rows and then rebuilt it.

Together these made the pages read as a place capabilities are listed rather
than a place they are managed. D202 additionally froze the Subagents page as
"one fixed-height global list", which spelled the read-only shape into the
decision log.

## Decision

1. **One workbench per page.** Each of Skills, MCP, and Subagents renders one
   toolbar above one elevated panel. The toolbar owns the level filter as a
   segmented control with live counts, one search field, the project picker,
   and the page's primary actions. The level becomes a filter over one list
   instead of a pair of sections; inside the panel each level is a group header
   row (level name, resolved `.agents` path, count) followed by its rows. Every
   row also carries its own level badge, so a row scrolled away from its group
   header still says where it lives.
2. **The pages author.** Create, edit, and delete return to Settings for all
   three capabilities, through the recovered editor sheets and the host calls
   that already existed. New capabilities land at the level the filter points
   at, and the primary action's tooltip names that destination. Destructive row
   actions live in a per-row overflow menu and arm before they fire: the first
   press relabels the item to ask for confirmation, and the arming lapses on
   its own after a few seconds or when the menu closes. This overrides D202's
   "one fixed-height global list with no project picker" for the Subagents page
   presentation only; subagents remain global-only, which is why that page has
   no level filter and no project picker.
3. **Busy is per row, and a refresh is not a first paint.** Only the row with
   an in-flight request is busy; the rest of the page stays interactive. A page
   tracks whether it has ever hydrated: skeletons render on first paint only,
   and every later load keeps the rows already on screen and dims the list
   while announcing the refresh to assistive technology.
4. **Enablement is optimistic.** The switch flips locally, the host call
   follows, and the previous position is restored only if the host refuses.
   Success needs no reload, because the local patch already matches what the
   host did — which removes both the skeleton flash and a round trip per
   toggle.
5. **`skills.reveal` takes the level.** `revealUserSkill` and the
   `IPC.invoke.skillReveal` handler now accept `{ id, level?, projectPath? }`
   and forward it to `skills.read`, which has always parsed both. The handler
   still accepts a bare id string, so no caller breaks.

## Consequences

- Reading and managing capabilities happen in the same place, and the Settings
  pages no longer depend on Extensions for authoring that the host already
  supported.
- Revealing a project-level skill opens that project's file. Previously the id
  alone was sent, so a project skill with no global counterpart of the same id
  could not be resolved.
- D202's frozen page shape is superseded for presentation. The data boundary it
  set — global-only documents under `~/.agents/subagents`, enabled state in
  `<data>/agent-capabilities/subagents.json`, nothing written into the Markdown
  — is unchanged.
- `maxTurns` is expressible as "no limit" in the Subagents editor. The field's
  old renderer default (24) came from a `DEFAULT_SUBAGENT_MAX_TURNS` constant
  that `f8868b81` removed; the parser now treats an absent `maxTurns` as
  unlimited, and `UserSubagentInput` treats `0` as clearing the override, so
  the editor leaves the field empty rather than imposing a cap that
  hand-writing the document would not.
- The change is renderer-only apart from the `skillReveal` payload widening.
  No host-core change, no new RPC, no storage or schema change.
