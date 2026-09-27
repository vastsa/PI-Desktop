# ADR 0151: Keep the work panel inside the fixed application window

- Status: Accepted
- Date: 2026-09-03
- Related: [01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [08-component-spec §5](../spec/04-ux/08-component-spec.md) ·
  [09-interaction-patterns §8](../spec/04-ux/09-interaction-patterns.md) ·
  [01-ipc-protocol](../spec/03-runtime/01-ipc-protocol.md) · E2E-056 · E2E-167
- Supersedes: ADR 0122 and the work-panel boundary clauses of ADR 0146
- Restores the internal-dock direction from ADR 0033

## Context

The work panel is already rendered as an in-flow flex sibling, but ADR 0122
made the renderer request a matching native reservation. Electron consequently
grew and later shrank the whole application window whenever the panel opened or
collapsed. The panel should behave like the left sidebar: its width is taken
from the existing client area and MainChat reflows beside it.

The native Browser `WebContentsView` does not require a larger window. It is
positioned from the renderer-measured panel rectangle, which remains valid when
the panel is inside the existing client area.

## Decision

1. The work panel remains a fixed-width, right-side in-flow flex column. Opening
   and collapsing animate its flex allocation between zero and the committed
   `244..720px` width without changing native BrowserWindow bounds.
2. The renderer keeps the `window/setWorkPanelReservation` seam at zero. Main
   normalizes every valid request to `{ requested: 0, reserved: 0 }` and never
   applies panel width or x-offset geometry.
3. The panel's inner left-edge separator is renderer-owned. Moving it left grows
   the panel into MainChat's internal space; moving it right returns space to
   MainChat. Pointer preview is frame-coalesced, release commits the preferred
   width, and Escape/cancellation/lost capture restores the press-time width.
4. Native window edges and corners continue to resize the application window,
   but never resize or reserve the work panel. The preferred panel width remains
   renderer-local and persists independently of native window bounds.
5. The Browser view continues to use the renderer-measured panel rectangle and
   is detached before the panel exit animation, because a native view cannot
   follow renderer CSS animation.

## Consequences

- Opening and collapsing no longer move the window edge or change the user's
  application bounds; the panel visibly occupies internal space like the left
  sidebar.
- MainChat may become narrower than its 360px readability target on small
  windows. This is the intentional fixed-window trade-off.
- Native reservation and chat-width IPC shapes remain as compatibility seams,
  but the current renderer does not use them for panel presentation or resize.
- Native window bounds persistence no longer needs to remove temporary panel
  geometry.

## Alternatives rejected

### Keep the native reservation from ADR 0122

Rejected because expanding the whole application window is the outward behavior
this change removes.

### Overlay the panel without flex allocation

Rejected because it would cover chat content and break the measured Browser
surface, keyboard order, and continuous reflow.

## References

- `docs/adr/0033-internal-dock-work-panel.md`
- `docs/adr/0122-reserve-native-width-while-work-panel-visible.md`
- `docs/adr/0146-separate-work-panel-and-chat-resize-ownership.md`
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/components/workpanel/WorkPanel.tsx`
- `apps/desktop/electron/main/index.ts`
