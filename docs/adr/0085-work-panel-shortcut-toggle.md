# ADR 0085: Make the work panel shortcut a toggle

- Status: Accepted for implementation
- Date: 2026-08-14
- Deciders: PI-Desktop core
- Amends: ADR 0068, D207
- Amended by: [ADR 0195](0195-viewport-fixed-work-panel-toggle.md) (the
  viewport-fixed toggle is the pointer equivalent; the header chevron is no
  longer a collapse control)
- Related: [01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [08-component-spec §5](../spec/04-ux/08-component-spec.md) ·
  [09-interaction-patterns §1](../spec/04-ux/09-interaction-patterns.md) ·
  E2E-056

## Context

ADR 0068 made `Cmd/Ctrl + J` an open-only action and rejected a toggle on the
grounds that the panel header already owns collapse and that a toggle risks
hiding the panel while the user is trying to reveal it. In use the asymmetry
reads as a broken shortcut instead of a safeguard: the same chord that reveals
the panel does nothing on the second press, so a keyboard-first user has to
move to the header control to put the panel away. Every other shell surface
bound to a chord (`Cmd/Ctrl + B` for the sidebar) toggles.

The accidental-hide risk 0068 guarded against is small because the shortcut is
symmetric and immediately reversible: the retained context, tabs, active
resource, and committed width all survive a collapse, so an unintended press is
undone by pressing again.

## Decision

1. `openWorkPanel` becomes a toggle. When the visible panel is open, the
   shortcut collapses it through the same path as the header collapse control;
   when it is closed, the shortcut reveals the active session's retained
   context at its committed width without creating a resource tab.
2. Collapsing via the shortcut retains the session's context exactly as the
   header control does — tabs, active resource, Browser resource, and committed
   width are preserved, so a second press restores the previous surface.
3. The shortcut id stays `openWorkPanel` so existing user keybinding overrides
   keep working; only the Settings → Shortcuts label changes to describe
   toggling.
4. The no-active-session and Settings no-op contexts from 0068 are unchanged,
   as are artifact-driven resource creation, session ownership, and
   background-event isolation. No host protocol, IPC channel, or native
   application-menu command is added.

## Consequences

- One chord both reveals and puts away the work panel, matching the sidebar.
- The header collapse control remains for pointer users and is now one of two
  equivalent entry points to the same store action.
- ADR 0068's "Make `Cmd/Ctrl + J` a toggle" rejected alternative no longer
  holds; 0068's remaining clauses stay in force.

## Alternatives considered

### Keep open-only and add a separate close chord

Rejected. A second binding spends scarce chord space on the inverse of an
existing one and still leaves the first chord feeling inert.

### Toggle only when the panel has no tabs

Rejected. Behavior that depends on invisible tab state is less predictable than
a plain toggle, and the retained context makes collapsing a populated panel
non-destructive anyway.

## References

- `docs/adr/0068-work-panel-keyboard-entry.md`
- `docs/spec/04-ux/01-ui-ia.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/04-ux/09-interaction-patterns.md`
- `docs/spec/08-meta/decisions-log.md` (D128, D142, D207, D221)
