# ADR 0238: Prioritize MainChat in the three-column shell

- Status: Accepted (sidebar width clamp amended by [ADR 0290](0290-resizable-sidebar-collapse-threshold.md))
- Date: 2026-09-13
- Amends: [ADR 0226](0226-reserve-chat-width-for-composer-controls.md) ·
  [ADR 0151](0151-internal-work-panel-dock.md) ·
  [ADR 0033](0033-internal-dock-work-panel.md) — the fixed `244..720px` clamp
  from D167/ADR 0033/ADR 0151 is replaced by the live budget below
- Related: [ADR 0033](0033-internal-dock-work-panel.md) ·
  [ADR 0151](0151-internal-work-panel-dock.md) ·
  [01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [07-ui-design-system §10](../spec/04-ux/07-ui-design-system.md) ·
  [08-component-spec §1 and §5](../spec/04-ux/08-component-spec.md) ·
  [09-interaction-patterns §8](../spec/04-ux/09-interaction-patterns.md) ·
  E2E-LAYOUT-three-column-width-priority

## Context

The renderer shell has three in-flow columns inside a fixed client area: the
expanded sidebar, MainChat and the work panel. ADR 0033 and ADR 0151 keep native
window bounds out of the panel's reach, but the shell still has no explicit
width priority.

## Decision

1. MainChat has a hard `450px` minimum, derived from the composer toolbar's
   unfolded row (plus button, mode and permission chips, model/thinking chip,
   enhance and send buttons) plus its margins.
2. When the expanded sidebar would make MainChat reach the 450px floor, the
   renderer immediately collapses the sidebar through the existing mounted
   `sidebar-out` animation.
3. A manual sidebar reopen spends work-panel width first.
4. Automatic sidebar collapse is remembered only until the work panel closes.
5. The window itself stays fixed.
6. The panel header exposes a preview (maximize) toggle.

## Consequences

- MainChat cannot be compressed below 450px by any supported shell width change;
  the sidebar is the column that yields.
- A constrained window shows a narrower work panel during the current layout,
  while the persisted preferred width remains available when space returns.
- The composer toolbar now handles widths between 450px and its comfortable
  layout instead of relying on a 515px reservation, so its control groups
  ellipsize or reflow below that width.
- No host protocol, SQLite schema, plugin contract, security boundary or native
  window geometry changes.

## Alternatives rejected

### Keep the 515px chat reservation of ADR 0226

Rejected because it leaves side-dock priority implicit and cannot satisfy the
450px hard floor with automatic sidebar-yield behaviour, which is what keeps
MainChat usable in the fixed window.

### Let the sidebar resize continuously to preserve every column

Rejected because the sidebar remains a discrete expanded/collapsed column for
this interaction.

### Mirror the committed panel width into native window bounds

Rejected because expanding the application window is the outward behaviour ADR
0033 and ADR 0151 removed.

## References

- `apps/desktop/src/lib/work-panel-resize.ts`
- `apps/desktop/src/components/workpanel/WorkPanel.tsx`
- `apps/desktop/src/features/app/useAppShellRuntime.tsx`
- `apps/desktop/src/features/app/AppShell.tsx`
- `apps/desktop/src/styles/chat-shell.css`
