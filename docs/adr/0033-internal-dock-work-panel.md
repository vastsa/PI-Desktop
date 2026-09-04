# ADR 0033: Internal-dock work panel (no native window expansion)

- Status: Superseded by ADR 0122; internal-dock direction restored by ADR 0151
- Date: 2026-07-30
- Related: [01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [08-component-spec §5](../spec/04-ux/08-component-spec.md) ·
  [09-interaction-patterns §8](../spec/04-ux/09-interaction-patterns.md) ·
  [01-ipc-protocol](../spec/03-runtime/01-ipc-protocol.md) · decision D163
- Supersedes in part: ADR 0032

## Context

ADR 0032 made the work panel a docked flex column but, to keep the chat width
stable, reserved *native window width* equal to the panel's committed width.
Main expanded the OS window (within the display work area) by that width and
positioned the native browser `WebContentsView` in the extended region. The
user-visible result is that opening the panel **grows the whole application
window** — it reads as the panel "expanding out separately" rather than
occupying space inside the existing window.

ChatGPT and WorkBuddy keep the window fixed and let the side panel take space
from inside the client area, pushing the conversation left. That is the
requested behavior.

Investigation showed the window expansion was only a *room-making* mechanism:

- The former interactive terminal tab did not use a native view; ADR 0108
  removes that surface entirely.
- Only the **browser** tab uses a native `WebContentsView`, and it is already
  positioned from the **renderer-measured** panel rect via `browserSetBounds`
  (see `BrowserPane.setBounds` and `BrowserTab`). The view composites above
  renderer content, so it must be told where to sit — but that rect is measured
  wherever the panel visually is, independent of whether the window grew.

Therefore the native width reservation is unnecessary for correctness: if the
panel becomes an in-flow column of a *fixed* window, the measured rect already
lands inside the window, and the browser view follows it without any window
expansion.

## Decision

1. The work panel is a fixed-width in-flow flex column inside the **fixed**
   client area. Opening it reflows `MainChat` to the left; it never expands the
   OS window.
2. The renderer always requests a native reservation width of `0`
   (`api.setWorkPanelReservation(0)`). Main no longer changes window bounds for
   the panel. The `window/setWorkPanelReservation` IPC is retained as a stable
   seam; Main returns an empty reservation (`{ requested: 0, reserved: 0 }`).
3. The native browser `WebContentsView` continues to be positioned from the
   renderer-measured panel rect via `browserSetBounds`. No window expansion is
   required for it to sit correctly.
4. The default committed width is **420px** (the established baseline), within
   the unchanged `364..720px` clamp. *(Superseded by decision D167: the default
   is 280px inside a `244..720px` clamp; every other clause here stands.)*
5. Native window-edge resize changes `MainChat` only, now by plain reflow
   (the panel is internal and stays at its committed width).

## Consequences

- The OS window size is stable across open / collapse / divider commit; only
  `MainChat` reflows. This matches ChatGPT / WorkBuddy.
- On small windows `MainChat` can be squeezed below its 360px readability
  target when the panel is open at a wide width — the same trade-off ChatGPT
  accepts, and acceptable here.
- Geometry logic is simpler: the reservation machinery is retained but inert,
  so the renderer→Main IPC surface and its tests stay valid.
- Persisted normal bounds already exclude reservation width; with reservation
  always `0` they are simply the user's window size, which is the desired
  relaunch behavior.
- The exit animation and native view detach-before-exit logic are unchanged.

## Alternatives

### Keep ADR 0032 (reserve native width, expand the window)

Rejected: expanding the whole window to make room for the panel is exactly the
"expands out separately" behavior the user wants to remove. It also makes the
panel feel disconnected from the in-window layout.

### Clip the native view with a separate overlay window

Rejected: adds a second window, focus/occlusion complexity, and a different
failure mode, for no benefit over measuring the in-flow rect.

## References

- `docs/adr/0032-reserve-native-width-for-the-docked-work-panel.md` (superseded
  in part)
- `apps/desktop/src/App.tsx` (reservation target set to `0`)
- `apps/desktop/src/lib/work-panel-resize.ts` (`WORK_PANEL_DEFAULT_WIDTH`)
- `apps/desktop/src/components/workpanel/BrowserTab.tsx` (`browserSetBounds`
  from measured rect)
- `apps/desktop/electron/main/browser-view.ts` (`BrowserPane.setBounds`)
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-056)
- `docs/spec/08-meta/decisions-log.md` (D163)
