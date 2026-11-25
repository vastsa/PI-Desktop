# ADR 0233: Renderer-Owned Multi-Folder Project Creation

- Status: Accepted; behavior superseded in part by ADR 0249, and amends ADR 0011
  and ADR 0016
- Date: 2026-09-12
- Related: ADR 0011, ADR 0016, ADR 0249

## Context

The existing project entry point opens a native directory picker and activates the
single directory it returns, while the redesigned Create project flow must collect a
project name and several local folders in one operation without expanding the
host-core boundary that exposes one current visible workspace.

## Decision

1. The renderer owns the Create project dialog: project name, selected-folder list,
   remove actions, primary marker, validation, focus handling, and creation state.
2. The main process exposes `project/pickFolders` as a narrow native capability that
   may open a multi-selection directory picker and returns absolute paths, without
   changing the active host workspace.
3. The first selected folder is the primary root of one logical project group:
   creation activates it and applies the display name to the group, every other
   folder is retained as a group root rather than an independent project tab, and the
   host still exposes only the primary root as the active workspace.
4. The sidebar and Settings entry points use the same dialog and action.

## Consequences

- Users can name a project and add several folders without repeating the entry flow,
  and the extra folders stay durable roots of the same group.
- Host RPC and the security boundary are unchanged apart from the additive directory
  picker, and the first folder's position is meaningful: choosing a different
  primary folder is out of scope.

## Alternatives

- Add multi-root execution to the host workspace: changes the frozen
  one-visible-workspace model and needs a separate containment design.
- Keep the native picker as the entire UI: cannot collect a name or expose removal.
