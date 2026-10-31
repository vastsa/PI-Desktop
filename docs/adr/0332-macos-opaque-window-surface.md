# ADR 0332: macOS keeps its translucent window surface with an opaque opt-out

- Status: Accepted
- Date: 2026-10-16
- Deciders: PI-Desktop maintainers
- Related: issue #1064, D665, D666, D667, D304, D348, ADR 0248 (theme assets and window
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

macOS keeps the translucent native surface the product has always shipped, and
the opaque surface is now the opt-out. The main window keeps its frameless
`hiddenInset` titlebar, its inset traffic-light position, its vibrancy material,
and the renderer's glass tint and sheen.

- `macosWindowSurfaceOptions(translucent, color)` is the single place that
  declares the macOS surface: `true` keeps `vibrancy: "sidebar"`,
  `visualEffectState: "followWindow"`, and the transparent `#00000000` backing;
  `false` paints an opaque `{ transparent: false, backgroundColor }` window that
  stays out of WindowServer's per-frame recomposition path (#1064).
- `AppSettings.macosWindowTranslucency` is the stored preference. Absent and
  `true` mean the shipped translucent surface; only `false` asks for the cheaper
  opaque one. It is read once, before `new BrowserWindow`, because Electron
  fixes `transparent` at creation, so a change is persisted for the next launch
  instead of mutating the window on screen. The Settings switch is darwin-only
  and shows a restart hint while the stored value differs from the surface the
  running process was created with.
- A translucent window owns its pixels: the post-creation background paint, the
  `window.setBackgroundColor` IPC, and `applyMainWindowBackground` all leave it
  alone. Painting a host or plugin palette over a transparent backing flattens
  the material, which is also what made an "enabled" switch look ignored. The
  opaque surface takes the colour on darwin like every other platform, so a
  plugin theme's `windowAppearance.backgroundColor` (ADR 0248) applies there.
- `applyNativeThemeSource` re-applies `setVibrancy("sidebar")` for a translucent
  window when the theme source changes; an opaque one has no material to reset.
- `mainWindowBackgroundOptions("darwin", color)` still describes the opaque
  surface, so a caller that only knows a platform never gets the material.

The renderer-side sidebar treatment is unchanged: `--ds-sidebar-glass-tint` and
the sheen paint the sidebar, splash, and rail over whichever surface the window
has, so the glass reads the same and the setting only changes what shows
through it.

## Consequences

- Default installs still pay the compositor cost of the material: translucency
  is the shipped look, so the per-frame recomposition described in Context
  remains for anyone who leaves the switch on. That is a product decision, not
  an oversight — the desktop blur is part of the window's language, and a
  default that silently dropped it changed the app under existing users.
- Turning the switch off paints the opaque surface and returns an idle focused
  window to the desktop GPU baseline measured under #1064. The setting is an
  opt-out, so the saving is one launch away without editing files or starting
  the app differently.
- The renderer tint, sheen, and layout are identical on both surfaces, so the
  switch changes only whether the desktop shows through; no other visual,
  persisted-data, or plugin contract changes.
- Plugins with a granted `ui.window.appearance` permission have their
  `windowAppearance.backgroundColor` applied on the opaque surface, matching
  Windows and Linux, and keep the vibrancy material on the translucent one —
  the same rule as before the setting existed (ADR 0248).
- The bounded-animation contract from #1064 stays in force on both surfaces. A
  dirty window is recomposited on every platform, and on macOS the material
  still multiplies that cost.

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
- **Make the setting live on a running window.** `transparent` is fixed when
  Electron creates the window, so a live change would either leave a
  transparent window with an opaque colour (keeping the compositor cost) or an
  opaque window that can never show the material. Persisting the preference for
  the next launch keeps one rendering path per process instead of a
  half-applied state.
- **Make the opaque surface the default.** Tried and reverted: an idle focused
  window stopped costing GPU time, but every existing user lost the material
  their window was designed around. The cost belongs behind a switch the user
  can see, not behind a silent default change.

## Evidence

- Issue #1064 (bounded idle status indicator animations, D348).
- `powermetrics --samplers gpu_power` A/B on Apple Silicon, focused-idle
  foreground vs. minimized, before and after this change.
- `apps/desktop/test/macos-opaque-window-surface.test.mjs` — window option and
  native-background contracts.
- `apps/desktop/test/macos-window-translucency.test.mjs` — the setting, its
  restart boundary, and the macOS-only Settings row.
- `apps/desktop/test/window-background.test.mjs` — per-platform surface colours.
