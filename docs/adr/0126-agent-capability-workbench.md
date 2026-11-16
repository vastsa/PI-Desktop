# ADR 0126: Agent Capability Pages Are One Workbench That Can Author

- Status: Accepted
- Date: 2026-08-27
- Related: ADR 0063, ADR 0112, D193, D194, D202
- Baseline: `0.10.8`

## Context

`d24e1ee0` moved Skills, MCP, and Subagents out of Extensions and into Settings
> Agent. The move carried the list and the enablement switch, but it deleted
`SkillEditorSheet.tsx` and `SubagentEditorSheet.tsx` along the way.

1. **The level was structure, not a filter.** Each page stacked a Global card
   block and a Project card block, each with its own heading, its own resolved
   path, its own count, and its own actions.
2. **One pending request locked the page.** Rows were rendered with
   `busy={loading || busyKey !== null}` and `disabled={loading || busyKey !==
   null}`, so toggling any one capability disabled every control on the page,
   including the unrelated level's rows.
3. **A toggle flashed the skeletons.** `toggle()` awaited `load()` on success,
   and `load()` set `loading` unconditionally, so a switch replaced the whole
   list with skeleton rows and then rebuilt it.

## Decision

1. **One workbench per page.** Each of Skills, MCP, and Subagents renders one
   toolbar above one elevated panel.
2. **The pages author.** Create, edit, and delete return to Settings for all
   three capabilities, through the recovered editor sheets and the host calls
   that already existed.
3. **Busy is per row, and a refresh is not a first paint.** Only the row with an
   in-flight request is busy; the rest of the page stays interactive.
4. **Enablement is optimistic.** The switch flips locally, the host call
   follows, and the previous position is restored only if the host refuses.
5. **`skills.reveal` takes the level.** `revealUserSkill` and the
   `IPC.invoke.skillReveal` handler now accept `{ id, level?, projectPath? }`
   and forward it to `skills.read`, which has always parsed both.

## Consequences

- Reading and managing capabilities happen in the same place, and the Settings
  pages no longer depend on Extensions for authoring that the host already
  supported.
- Revealing a project-level skill opens that project's file.
- D202's frozen page shape is superseded for presentation.
- `maxTurns` is expressible as "no limit" in the Subagents editor.
- The change is renderer-only apart from the `skillReveal` payload widening.
