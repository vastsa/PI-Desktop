# Windows native snapping validation

- Date: 2026-11-13
- Issue: https://github.com/vastsa/PI-Desktop/issues/2330
- Classification: confirmed upstream defect.
- Refreshed upstream base: `d2a2556d4e3f4997935eeb14cfc3f2909acafd0f`.
- Tested implementation and fixture: `f1f6a44aa` (production fix `463a025d4`).
- Environment: Windows 11 `10.0.26100`, Electron `43.6.0`, 100% scale,
  single 2560×1440 remote desktop, work area `(0,0) 2560×1392`.

## Reproduction and decision

An independent native comparison on the same Windows desktop and pinned
Electron reproduced unchanged bounds after Win+Left/Right with
`frame:false, thickFrame:false`, style `0x14030000`. Restoring only
`WS_THICKFRAME` restored snapping but left the maximized DWM-visible rectangle
one pixel outside each work-area edge. Enabling Electron's thick frame instead
introduced native client insets. Restoring `WS_THICKFRAME | WS_CAPTION` while
retaining Electron's inset-free layout removed that maximized overshoot.
Suppressing the Windows 11 DWM border removed its painted client-edge outline.

## Candidate verification

The Windows Host was compiled from the candidate source. The portable fixture
was prepared with `node scripts/e2e-window-snap.mjs --prepare <directory>
--external-pointer`, using explicit Windows Host and Electron paths. PowerShell
`Add-Type` compiled `probe.cs`; the resulting probe ran in the dedicated test
account's interactive desktop. RDP supplied pointer input through the documented
request/acknowledgement adapter. The independent Win32 probe measured geometry,
foreground ownership, hit testing, minimum sizes, pixels and window states;
input acknowledgements were not treated as passing assertions.

The final `--baseline` fixture, with native snap installation omitted, failed
at `Win+Left did not snap to the work-area half` after 11 assertions. Bounds
remained `(200,140) 1200×800`, confirming the same harness detects the defect.

The final candidate passed **121 assertions**:

| Operation | Observed result |
| --- | --- |
| Win+Left / Win+Right | `(0,0) 1280×1392` / `(1280,0) 1280×1392` |
| Physical titlebar drag to left edge | `(0,0) 1280×1392` |
| Normal/snapped/restored client edges | No native insets or painted rim |
| Native edge resize | Width grew from 1200 to 1295 |
| Native minimum size | Width 800 and height 560 enforced independently |
| Win+Up / Win+Down | Maximize, restore and minimize succeeded |
| Maximize and minimize/restore | Client and DWM-visible frame equal work area |
| Fullscreen and exit | Display filled; normal frame and snapping restored |
| Invalid HWND, wrong PID, foreign HWND | Host rejected requests; foreign style unchanged |
| Fixture exit | Isolated Host retired before successful completion |

Maximized `GetWindowRect` includes invisible native resize margins:
`(-8,-8) 2576×1408`. Its client and DWM-visible rectangles are both
`(0,0) 2560×1392`; those are the relevant overflow assertions.

Additional checks passed: 27 targeted window tests, Desktop typecheck, lint,
documentation checks, targeted Rust formatting and the current-main base gate.
During fixture hardening, partial command reads and Windows file-sharing
violations were observed and corrected before the final passing run.

## Limits

This validates production Main snapping/corner/fullscreen services with the
real Host in an isolated Electron window, not an installed application build
or the complete renderer. Native Windows 10, mixed-monitor DPI and the older
transparent surface were not qualified. Hover Snap Layouts on the custom
maximize button require separate `HTMAXBUTTON` integration and are outside
this keyboard/titlebar snapping fix. No release was built or published.
