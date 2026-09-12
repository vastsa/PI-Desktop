# ADR 0235: Prioritize MainChat in the three-column shell

- Status: Accepted
- Date: 2026-09-12
- Amends: [ADR 0151](0151-internal-work-panel-dock.md) ·
  [ADR 0226](0226-reserve-chat-width-for-composer-controls.md)
- Related: [01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [07-ui-design-system §10](../spec/04-ux/07-ui-design-system.md) ·
  [08-component-spec §5](../spec/04-ux/08-component-spec.md) ·
  [09-interaction-patterns §8](../spec/04-ux/09-interaction-patterns.md) ·
  E2E-LAYOUT-three-column-width-priority

## Context

The renderer shell has three in-flow columns: the expanded sidebar, MainChat,
and the work panel. The previous fixed-window contract protected a 515px chat
reservation but allowed the side docks to compete for the remaining width. It
also left pointer/keyboard panel resizing, native window resizing, and sidebar
toggle paths with different width rules.

Issue #267 makes the priority explicit: MainChat must remain usable first, the
work panel is second, and the sidebar is the first column to yield. The rule
must also work during a drag preview, before a pointer release can commit a new
preferred width.

## Decision

1. MainChat has a hard `360px` minimum. The effective work-panel maximum is
   `min(720px, clientWidth - mainChatMinimum - expandedSidebarWidth)`. The
   shared renderer budget function is used by pointer preview, keyboard resize,
   panel presentation, sidebar changes, and shell resize observation.
2. When the expanded sidebar would make MainChat reach the 360px floor, the
   renderer immediately collapses the sidebar through the existing mounted
   `sidebar-out` animation. The preferred work-panel width remains the user's
   persisted target, so the panel can continue growing after the sidebar has
   yielded.
3. A manual sidebar reopen spends work-panel width first. It preserves the
   current MainChat width where possible; if the 360px floor would be crossed,
   it targets `370px`. This reopen path may persist a positive compact panel
   width below the ordinary 244px presentation minimum.
4. Automatic sidebar collapse is remembered only until the work panel closes.
   Closing the panel restores a sidebar collapsed by the layout mechanism.
   Manual sidebar collapse, manual reopen, and a subsequent manual collapse
   clear that record.
5. The renderer still owns the in-flow panel and its divider. On a normal
   non-maximized window, the committed preferred panel width is mirrored to
   `window/setWorkPanelReservation`; Electron returns both `requested` and
   `reserved`. Maximized/fullscreen windows report no native reservation and
   rely on the renderer budget. Compact positive reservations from the reopen
   path are valid from `1px` through `720px`; `0` releases the reservation.

## Consequences

- MainChat cannot be compressed below 360px by any supported shell width
  change.
- A constrained maximized/fullscreen window may show a narrower work panel
  during the current layout, while the persisted preferred width remains
  available when space returns.
- Opening a panel on a non-maximized window may grow the native window, and
  closing it releases that reservation after the exit animation.
- No host protocol, SQLite schema, plugin contract, or security boundary
  changes.

## Alternatives rejected

### Keep the 515px MainChat reservation and fixed-window dock

Rejected because it makes side-dock priority implicit and does not satisfy the
360px hard floor and automatic sidebar-yield behavior required by issue #267.

### Let the sidebar resize continuously to preserve all columns

Rejected because the sidebar remains a discrete expanded/collapsed column for
this interaction. Its user-selected preferred width is not silently mutated by
window pressure.

## References

- `apps/desktop/src/lib/work-panel-resize.ts`
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/components/workpanel/WorkPanel.tsx`
- `apps/desktop/electron/main/work-panel-window.ts`
- `apps/desktop/electron/main/index.ts`
