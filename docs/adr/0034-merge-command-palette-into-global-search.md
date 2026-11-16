# ADR 0034: Merge the command palette into global search

- Status: Accepted
- Date: 2026-07-30
- Related: [08-component-spec §16](../spec/04-ux/08-component-spec.md) ·
  [09-plugin-command-palette](../spec/07-plugins/09-plugin-command-palette.md) ·
  decision D014

## Context

The app shipped two overlapping "find anything" overlays with the same
interaction model: a command palette (Cmd/Ctrl+Shift+P) listing built-in and
plugin commands, and a global search (Cmd/Ctrl+K) listing sessions, pages, and
settings. Keeping both meant duplicated maintenance, a second top-bar button,
and a split mental model for users.

## Decision

Remove the standalone command palette overlay and its top-bar button, and render
the built-in plus plugin command list as a Commands section inside the existing
global search dialog, using the same listbox/option semantics and flat
option-index navigation as the other result groups. The `openCommandPalette`
shortcut (Cmd/Ctrl+Shift+P, per D014) now opens that dialog and is retained so
the keyboard-shortcuts page and plugin command discovery keep working, while
`api.searchCommands` and `runPaletteCommand` remain the unchanged data path. The
redundant View-menu entry goes away because the menu already has Search.

## Consequences

- One searchable surface covers sessions, pages, settings, and commands, and
  muscle memory for Cmd/Ctrl+Shift+P still lands on commands.
- The top bar loses a button and the palette surface, CSS, and `paletteOpen`
  state are deleted.
- Plugin command discovery and disable-removes-contributions scenarios are
  re-expressed against global search.

## Alternatives

- Keep two surfaces: rejected, it duplicates interaction logic and forces users
  to remember which surface holds what.
- Show commands only for a non-empty query: rejected, the palette listed all
  commands with an empty query, so the Commands section renders then too.
