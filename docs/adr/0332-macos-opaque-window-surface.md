# ADR 0332: macOS paints an opaque native window surface

- Status: Accepted
- Date: 2026-10-16
- Deciders: PI-Desktop maintainers
- Related: issue #1064, D665, D304, D348, ADR 0248 (theme assets and window
  background), ADR 0260 (plugin runtime theme APIs),
  `docs/spec/04-ux/07-ui-design-system.md`,
  `docs/spec/04-ux/08-component-spec.md`

## Context

The macOS main window was created as a frameless `hiddenInset` window with
`vibrancy: "sidebar"`, `visualEffectState: "followWindow"`, `transparent: true`
and a `#00000000` backing. WindowServer composited the vibrancy material behind
the translucent Electron surface, and the renderer painted a thin tint plus
sheen over it to read as glass (D348).

That combination made the window surface continuously expensive. A vibrancy
material behind a transparent surface is re-composited by WindowServer whenever
the window stays dirty, and on the target hardware the cost was large and
unconditional: measured with `powermetrics --samplers gpu_power` on an Apple
Silicon machine, an idle focused window held GPU at

```text
desktop idle baseline       avg 3.6%   max  9.3%
PI-Desktop focused, idle    avg 40.9%  max 55.6%
PI-Desktop minimized        avg 3.2%   max  6.1%
```

Idle page content was not the cause: with the window focused and no session
running, the app's own GPU process consumed no measurable CPU time and the
renderer submitted no frames of its own. Minimizing removed the window from the
compositor's work and the GPU returned to the desktop baseline.

Earlier work on the same profile (#1064, D348) bounded idle-reachable indicator
animations so they could not hold the surface dirty forever. That reduced the
load but could not remove it: the material itself kept the window in the
compositor's per-frame path while it was visible and focused.

## Decision

macOS paints an opaque native surface. The main window keeps its frameless
`hiddenInset` titlebar, its inset traffic-light position, and the renderer's
glass tint and sheen, but no longer declares `vibrancy`, `visualEffectState`, or
a transparent backing. The window's native background comes from the same
platform helper the other platforms use, so a theme change repaints it instead
of being skipped on `darwin`.

- `mainWindowBackgroundOptions("darwin", color)` returns an opaque
  `{ transparent: false, backgroundColor }` surface.
- `applyMainWindowBackground` applies the colour on darwin like every other
  platform; the `win32` content-view and Windows 11 DWM branches are unchanged.
- `applyNativeThemeSource` no longer calls `setVibrancy` — there is no material
  to reset when the theme source changes.
- The `window.setBackgroundColor` IPC no longer returns early on darwin, so a
  plugin theme's `windowAppearance.backgroundColor` is applied on macOS too
  (ADR 0248), for the palette the renderer has resolved.

The renderer-side sidebar treatment is unchanged: `--ds-sidebar-glass-tint` and
the sheen still paint the sidebar, splash, and rail so the surface keeps
reading as glass. The tint is now composited over the opaque host palette
rather than over a live blur, which is what keeps the visual language intact
without the per-frame material cost.

## Consequences

- An idle focused window returns to the desktop GPU baseline: after the change
  the same measurement showed the focused-idle case matching the idle baseline
  instead of ~40%.
- macOS loses the live wallpaper blur behind the sidebar. The tint and sheen
  keep the glass appearance; the material is no longer translucent to desktop
  content.
- Plugins with a granted `ui.window.appearance` permission now have their
  `windowAppearance.backgroundColor` applied on macOS, matching Windows and
  Linux. Previously darwin silently ignored it because vibrancy owned the
  surface (ADR 0248 said darwin "never receives a colour"; that exclusion is
  superseded).
- The bounded-animation contract from #1064 stays in force. Its rationale text
  referenced the transparent/vibrancy window, which no longer describes the
  window; the rule itself (no unbounded idle animation) is still required
  because a dirty window is recomposited on every platform.

## Alternatives rejected

- **Keep vibrancy and bound every animation that can reach an idle screen.**
  This was the #1064 approach and it did reduce the load, but it cannot remove
  it: the material keeps the window in the compositor's per-frame path while it
  is visible and focused, independently of what the renderer paints. It also
  leaves the cost coupled to every new idle-reachable animation.
- **Drop only `visualEffectState: "followWindow"`.** The window already used
  `followWindow`, so this was a no-op; the material behaviour is what costs.
- **Drop transparency but keep vibrancy.** A vibrancy material without a
  transparent surface still has WindowServer composite the material; the
  transparent backing is what let it blend, not what made it expensive.
- **Make the opaque surface opt-in behind a setting.** The load is present on
  default installs, and a setting would leave every default user with the
  regression while adding a second rendering path to maintain.

## Evidence

- Issue #1064 (bounded idle status indicator animations, D348).
- `powermetrics --samplers gpu_power` A/B on Apple Silicon, focused-idle
  foreground vs. minimized, before and after this change.
- `apps/desktop/test/macos-opaque-window-surface.test.mjs` — window option and
  native-background contracts.
- `apps/desktop/test/window-background.test.mjs` — per-platform surface colours.
