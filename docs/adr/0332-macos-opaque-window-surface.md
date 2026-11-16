# ADR 0332: macOS keeps its translucent window surface with an opaque opt-out

- Status: Accepted
- Date: 2026-10-16
- Related: issue #1064, D665, D666, D667, D304, D348, ADR 0248, ADR 0260,
  `docs/spec/04-ux/07-ui-design-system.md`

## Context

The macOS main window combined a frameless `hiddenInset` titlebar with
`vibrancy: "sidebar"`, `visualEffectState: "followWindow"`, `transparent: true`,
and a `#00000000` backing, so WindowServer re-composited the material whenever
the visible focused window stayed dirty — an idle focused window held GPU at
roughly 41% average on Apple Silicon against a 3.6% desktop baseline, while a
minimized window returned to baseline. Bounding idle-reachable animations
(#1064, D348) reduced but could not remove that cost, because the material itself
keeps the window in the compositor's per-frame path.

## Decision

macOS keeps the translucent native surface it has always shipped and the opaque
surface becomes the opt-out. `macosWindowSurfaceOptions(translucent, color)` is
the single declaration of the surface: `true` keeps `vibrancy: "sidebar"`,
`visualEffectState: "followWindow"`, and the transparent backing, while `false`
paints an opaque `{ transparent: false, backgroundColor }` window outside
WindowServer's recomposition path. `AppSettings.macosWindowTranslucency` stores
the preference, absent and `true` meaning translucent, and it is read once before
`new BrowserWindow` because Electron fixes `transparent` at creation, so a change
applies on the next launch and the darwin-only Settings switch shows a restart
hint while the stored value differs from the running surface.

A translucent window owns its pixels: the post-creation background paint, the
`window.setBackgroundColor` IPC, and `applyMainWindowBackground` leave it alone,
because painting a palette over a transparent backing flattens the material. The
opaque surface takes the colour on darwin like other platforms, so a plugin
theme's `windowAppearance.backgroundColor` (ADR 0248) applies there, and
`applyNativeThemeSource` re-applies `setVibrancy("sidebar")` only for a
translucent window. The renderer's `--ds-sidebar-glass-tint` and sheen are
unchanged, so the glass reads the same on either surface.

## Consequences

- Default installs still pay the compositor cost, which is a product decision:
  a silent default change would remove the desktop blur existing users expect.
- Turning the switch off returns an idle focused window to the desktop GPU
  baseline measured under #1064, one launch away.
- Only what shows through the window changes; no other visual, persisted-data, or
  plugin contract is affected, and the bounded-animation contract stays in force
  on both surfaces.

## Alternatives rejected

- Bound every idle-reachable animation instead: the material keeps the window in
  the per-frame path independently of what the renderer paints.
- Make the opaque surface the default: tried and reverted, because every
  existing user lost the material their window was designed around.
- Change the setting on a running window: `transparent` is fixed at creation, so
  it would leave a half-applied state.
