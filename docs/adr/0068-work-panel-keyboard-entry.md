# ADR 0068: Add a keyboard entry point for the work panel

- Status: Accepted for implementation
- Date: 2026-08-07
- Amends: D128, D142
- Amended by: [ADR 0085](0085-work-panel-shortcut-toggle.md) (the shortcut is a
  toggle; the rejected toggle alternative below no longer holds);
  [ADR 0195](0195-viewport-fixed-work-panel-toggle.md) (pointer equivalent)
- Amended in part by: [ADR 0108](0108-remove-built-in-interactive-terminal.md)
- Related: [01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [09-interaction-patterns §1](../spec/04-ux/09-interaction-patterns.md)

## Context

D128 made the work panel artifact-only and removed a global shortcut, so a user who
collapses the panel or closes its last resource has no direct way back to the
session's retained panel. The header already offers the resource chooser, so the
missing capability is panel entry, not another resource protocol.

## Decision

Add the shared `openWorkPanel` shortcut with a default `Cmd/Ctrl + J` binding,
overridable and resettable through the existing shortcut settings. With an active
session it reopens that session's retained panel at its committed width without
creating or activating a tab, leaving existing tabs and resources unchanged. The
empty header stays the manual chooser, Review opens only on explicit user action
(D451), a plan or goal approval artifact still creates or activates a tab in its
originating session (D452), and the shortcut is ignored in Settings and is a no-op
without an active session.

## Consequences

- Users can reopen the panel without waiting for another artifact.
- An open panel no longer implies a resource exists; the empty header is a
  deliberate chooser state.
- The change stays renderer-local and preserves session-scoped ownership and width
  reservation.

## Alternatives

- Keep artifact-only entry — rejected: a collapsed panel with a valid context
  stayed unreachable.
- Create a Review resource on the shortcut — rejected: it would fabricate a
  workspace change and impose a tool choice.
