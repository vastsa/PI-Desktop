# ADR 0233: Renderer-Owned Multi-Folder Project Creation

- Status: Accepted; behavior superseded in part by ADR 0249
- Date: 2026-09-12
- Deciders: PI-Desktop desktop UI maintainers
- Amends: ADR 0011, ADR 0016

## Context

The existing project entry point opens a native directory picker and activates
the single directory returned by it. The redesigned Create project flow needs
to collect a project name and support selecting multiple local folders in one
operation, while preserving the host-core boundary that exposes one current
visible workspace.

Treating the selected folders as one new host workspace would expand the
runtime ownership model and make session, instruction, and file-access
semantics ambiguous. Treating all but the first folder as temporary UI state
would also lose the user's explicit project choices.

## Decision

1. The renderer owns the Create project dialog, including the project name,
   selected-folder list, remove actions, primary marker, validation, focus
   handling, and creation state.
2. The main process exposes `project/pickFolders` as a narrow native capability.
   It may open a multi-selection directory picker and returns absolute paths;
   it does not change the active host workspace.
3. The first selected folder is the primary root of one logical project group.
   Creation activates it and applies the entered display name to the group;
   every other selected folder is retained as a group root, not as an
   independent project tab. The host still exposes only the primary root as the
   currently active workspace.
4. The sidebar and Settings project entry points use the same dialog and
   creation action.

## Consequences

- Users can name a project and add multiple folders without repeating the
  project-entry flow.
- Additional folders remain available as durable roots of the same named project group.
- The host RPC and security boundary remain unchanged apart from the additive
  directory-picker capability; switching tabs still changes the one active
  host workspace through the existing project activation path.
- The first folder's position is meaningful. Reordering or choosing a
  different Primary folder is intentionally out of scope for this iteration.

## Alternatives considered

- **Add multi-root execution to the host workspace:** rejected because it changes
  the frozen one-visible-workspace model and requires a separate containment and
  permission design. ADR 0249 adds logical group ownership without broadening
  builtin tool roots.
- **Keep the native picker as the entire UI:** rejected because it cannot
  collect a project name, expose selected-folder removal, or provide a
  consistent ChatGPT-like creation surface.
- **Open each folder in a separate user action:** rejected because it makes a
  multi-folder setup slow and hides the relationship between the selected
  folders during creation.
