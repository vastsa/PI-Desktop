# ADR 0033: Internal-dock work panel (no native window expansion)

- Status: Superseded by ADR 0122; internal-dock direction restored by ADR 0151
- Date: 2026-07-30
- Related: [01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [08-component-spec §5](../spec/04-ux/08-component-spec.md) ·
  [09-interaction-patterns §8](../spec/04-ux/09-interaction-patterns.md) ·
  [01-ipc-protocol](../spec/03-runtime/01-ipc-protocol.md) · decision D163
- Supersedes in part: ADR 0032

## Context

ADR 0032 made the work panel a docked flex column but reserved native window
width equal to the panel's committed width, so Main grew the OS window and
placed the browser `WebContentsView` in the extended region. Opening the panel
therefore grew the whole application window, reading as a separate expansion
rather than space taken inside the existing window.

ChatGPT and WorkBuddy keep the window fixed and let the panel take space from the
client area, pushing the conversation left.

The expansion turned out to be only a room-making mechanism. The former
interactive terminal tab used no native view and is removed by ADR 0108, and
native views are positioned from the renderer-measured panel rect via
`setBounds`, which lands inside a fixed window anyway.

## Decision

1. The work panel is a fixed-width in-flow flex column inside the **fixed**
   client area; opening it reflows `MainChat` left and never expands the OS
   window.
2. The renderer always requests a native reservation of `0`
   (`api.setWorkPanelReservation(0)`), and Main returns
   `{ requested: 0, reserved: 0 }`. The `window/setWorkPanelReservation` IPC is
   retained as a stable seam.
3. Native `WebContentsView`s keep being positioned from the renderer-measured
   panel rect via `browserSetBounds`, which needs no window expansion.
4. The default committed width is **420px** within the `364..720px` clamp.
   *(Superseded by decision D167: the default is 280px inside a `244..720px`
   clamp; every other clause here stands.)* *(Amended by ADR 0238: the clamp
   becomes the live three-column budget — 244px minimum, no fixed maximum,
   MainChat floor 360px.)*
5. Native window-edge resize changes `MainChat` only, by plain reflow.

## Consequences

- The OS window size is stable across open, collapse, and divider commit; only
  `MainChat` reflows, matching ChatGPT / WorkBuddy.
- On small windows `MainChat` can be squeezed below its 360px readability target
  at a wide panel width — the trade-off ChatGPT accepts.
- Reservation machinery is retained but inert, so the renderer→Main IPC surface
  and its tests stay valid, and persisted bounds are simply the user's window
  size.
- Exit animation and native view detach-before-exit logic are unchanged.

## Alternatives

- Keep ADR 0032: rejected, expanding the window is the behavior being removed,
  and it disconnects the panel from the in-window layout.
- Clip the native view with a separate overlay window: rejected, it adds a second
  window with focus and occlusion complexity for no benefit over measuring the
  in-flow rect.
