# ADR 0148: Keep the work panel inside the application window

- Status: Accepted
- Date: 2026-09-04
- Related: ADR 0033, ADR 0122, ADR 0146, decisions D142/D255/D286/D287,
  E2E-056
- Supersedes: ADR 0122; the right-edge panel-resize ownership clause of ADR 0146

## Context

The work panel is an in-flow renderer column, but the shell reserves matching
native width before showing it. On displays with enough room Electron expands
the BrowserWindow, so the conversation does not narrow as the panel enters.
The visible collapse control also belongs to the panel header, which replaces
the expected stable top-right toggle after the panel appears. Together these
behaviors make the panel feel like an external window extension rather than a
Codex-style sidebar entering the current application frame.

## Decision

1. Keep the work panel as an in-flow flex sibling of MainPane, but keep the
   BrowserWindow bounds fixed when it opens or closes. The renderer continues
   to use the existing reservation IPC seam with target `0`; it does not request
   the committed panel width.
2. Animate panel `width` and `flex-basis` from zero to the committed width while
   translating it in from the right. MainPane therefore narrows continuously
   during entry and expands continuously during exit.
3. Render one persistent AppShell-owned work-panel toggle in the conversation
   topbar band on every non-Settings route. Anchor it to the same viewport
   position in both states, ahead of native window
   controls on Windows/Linux, and keep it above the panel header while open.
   Remove the duplicate panel-header collapse control.
4. Native window edges return to ordinary BrowserWindow resizing. The renderer
   divider remains the explicit work-panel width control and keeps the existing
   bounded preference, pointer, keyboard, and native-surface blocking rules.

## Consequences

- Opening the panel leaves the application frame and top-right toggle fixed
  while the conversation visibly yields the panel's width.
- Closing reverses the same motion; the chat width returns without a pre-motion
  jump or native-window position drift.
- The existing exit keep-alive still detaches native Browser/plugin surfaces
  before the panel unmounts.
- Right-edge resizing no longer changes the panel target. Users resize the
  panel from its inner divider and resize the application from native edges.

## Alternatives rejected

### Overlay the panel above MainPane

Rejected because it would preserve the toggle position by covering the
conversation instead of narrowing it.

### Keep native width reservation

Rejected because added BrowserWindow width cancels the intended conversation
reflow and can move the application frame across the display.

## References

- `apps/desktop/src/App.tsx`
- `apps/desktop/src/components/ConversationTopbar.tsx`
- `apps/desktop/src/styles/work-panel.css`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/04-ux/09-interaction-patterns.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
