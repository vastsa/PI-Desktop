# ADR 0085: Make the work panel shortcut a toggle

- Status: Accepted for implementation; amends ADR 0068 and D207, and is amended
  by [ADR 0195](0195-viewport-fixed-work-panel-toggle.md) (the viewport-fixed
  toggle is the pointer equivalent; the header chevron no longer collapses)
- Date: 2026-08-14
- Related: D128, D142, D221, ADR 0068, ADR 0195

## Context

ADR 0068 made `Cmd/Ctrl + J` open-only, because the panel header already owned
collapse and a toggle might hide the panel mid-reveal. In use the asymmetry reads
as broken: the chord that reveals the panel does nothing on a second press, while
every other shell chord (`Cmd/Ctrl + B` for the sidebar) toggles. The risk is
small because collapsing is immediately reversible.

## Decision

1. `openWorkPanel` becomes a toggle: an open visible panel collapses through the
   same path as the header control, and a closed panel reveals the active
   session's retained context at its committed width without creating a resource
   tab.
2. Collapsing retains tabs, active resource, Browser resource, and committed
   width, so a second press restores the previous surface.
3. The shortcut id stays `openWorkPanel` so existing keybinding overrides keep
   working; only the Settings → Shortcuts label changes.
4. The no-active-session and Settings no-op contexts from ADR 0068 are unchanged,
   as are artifact-driven resource creation, session ownership, and background
   event isolation; no host protocol, IPC channel, or menu command is added.

## Consequences

- One chord both reveals and puts away the panel, matching the sidebar, while the
  header control remains a pointer entry point.
- ADR 0068's toggle-rejection alternative no longer holds; its remaining clauses
  stay in force.

## Alternatives

- Open-only plus a separate close chord: spends scarce chord space on the inverse
  of an existing binding.
- Toggle only when the panel has no tabs: depends on invisible state.
