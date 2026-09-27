# ADR 0068: Add a keyboard entry point for the work panel

- Status: Accepted for implementation
- Date: 2026-08-07
- Deciders: PI-Desktop core
- Amends: D128, D142
- Amended by: [ADR 0085](0085-work-panel-shortcut-toggle.md) (the shortcut is a
  toggle; the rejected toggle alternative below no longer holds);
  [ADR 0195](0195-viewport-fixed-work-panel-toggle.md) (pointer equivalent of
  the shortcut)
- Amended in part by: [ADR 0108](0108-remove-built-in-interactive-terminal.md)
- Related: [01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [08-component-spec §5](../spec/04-ux/08-component-spec.md) ·
  [09-interaction-patterns §1](../spec/04-ux/09-interaction-patterns.md) ·
  E2E-056

## Context

D128 made the work panel artifact-only and explicitly removed a global
shortcut. That keeps startup quiet, but it leaves a user with no direct way to
return to a session's retained panel after collapsing it or closing its last
resource. The existing panel header already provides the resource chooser, so
the missing capability is panel entry rather than a new resource protocol.

## Decision

1. Add the shared `openWorkPanel` shortcut with a default `Cmd/Ctrl + J`
   binding. The existing shortcut settings surface can override and reset it
   using the same conflict and reserved-key validation as other shortcuts.
2. When an active session exists, the shortcut sets that session's retained
   panel context to open at its committed width without creating or activating a
   resource tab. Existing tabs, active resource, and Browser resource remain
   unchanged.
3. The empty panel header remains the manual resource chooser for Browser
   and in-scope plugin views. Artifact triggers continue to create and activate
   resources atomically, and background-session artifacts cannot open the
   visible panel.
4. The shortcut is ignored while Settings is active and is a no-op without an
   active session. No host protocol, IPC channel, or native application-menu
   command is added.

## Consequences

- Users can reopen the work panel without waiting for another artifact.
- Opening the panel no longer implies that a resource exists; the empty header
  is an intentional chooser state.
- The change remains renderer-local and preserves session-scoped ownership,
  width reservation, and startup reset behavior.
- macOS application menus remain unchanged; the shortcut is discoverable and
  editable in Settings → Shortcuts.

## Alternatives considered

### Keep artifact-only entry

Rejected. A collapsed or last-resource-closed panel could not be reopened
directly even though its session context remained valid.

### Make `Cmd/Ctrl + J` a toggle

*(Amended by ADR 0085: the shortcut now toggles.)* Rejected at the time.
Collapse already has a dedicated panel control, and an explicit open
action avoids accidentally hiding the panel while the user is trying to reveal
its tools.

### Create Review on shortcut

Rejected. A shortcut should reveal the work surface without fabricating a
workspace change resource or imposing a default tool choice.

## References

- `docs/spec/04-ux/01-ui-ia.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/04-ux/09-interaction-patterns.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-056)
- `docs/spec/08-meta/decisions-log.md` (D128, D142, D207)
