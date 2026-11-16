# ADR 0034: Merge the command palette into global search

- Status: Accepted
- Date: 2026-07-30
- Related: [08-component-spec §16](../spec/04-ux/08-component-spec.md) ·
  [09-plugin-command-palette](../spec/07-plugins/09-plugin-command-palette.md) ·
  [04-builtin-commands](../spec/04-ux/04-builtin-commands.md) ·
  [04-e2e-test-plan](../spec/06-delivery/04-e2e-test-plan.md) · decision D014
- Updates: removes the standalone command palette surface described in
  [08-component-spec §16](../spec/04-ux/08-component-spec.md)

## Context

The app shipped two overlapping "find anything" surfaces:

- A **command palette** (Cmd/Ctrl+Shift+P) that lists built-in and plugin
  commands, opened from a dedicated top-bar button and a separate overlay.
- A **global search** (Cmd/Ctrl+K) that lists sessions, pages, and settings.

## Decision

1. Remove the standalone command palette overlay (`CommandPalette.tsx`) and its
   top-bar button.
2. Render the command list (built-in + plugin commands) as a **Commands**
   section inside the existing global search dialog (`SearchDialog.tsx`), using
   the same `role="listbox"` / `role="option"` semantics and flat option-index
   navigation as the other result groups.
3. The `openCommandPalette` shortcut (Cmd/Ctrl+Shift+P, per D014) now opens the
   global search dialog, which contains the Commands section.
4. Remove the redundant "Command Palette" entry from the application View menu
   (the View menu already has "Search").
5. The command data path is unchanged: `api.searchCommands` and
   `runPaletteCommand` (built-in + plugin bridge) are reused by the search
   dialog.

## Consequences

- One searchable surface covers sessions, pages, settings, and commands.
- The top bar loses a button; search is the single entry point for discovery.
- `Cmd/Ctrl+Shift+P` still works and now lands on the unified search with the
  command list available; muscle memory is preserved.
- `CommandPalette.tsx`, its CSS surface, and the `paletteOpen` state are
  removed.
- Plugin command discovery (E2E-023) and disable-removes-contributions (E2E-025)
  are re-expressed against the global search.

## Alternatives

### Keep two separate surfaces

Rejected: duplicates interaction logic and UI, adds a second top-bar button, and
forces users to decide which surface holds what.

### Hide commands behind a query in global search

Rejected: the command palette was reachable with an empty query
(Cmd/Ctrl+Shift+P showed all commands).

## References

- `apps/desktop/src/components/SearchDialog.tsx` (Commands section)
- `apps/desktop/src/components/ConversationTopbar.tsx` (button removed)
- `apps/desktop/src/App.tsx` (`openCommandPalette` → opens search)
- `apps/desktop/electron/main/application-menu.ts` (menu item removed)
- `apps/desktop/src/lib/api.ts` (`searchCommands` reused)
- `apps/desktop/src/lib/commands.ts` (`runPaletteCommand` reused)
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-023, E2E-025 updated)
