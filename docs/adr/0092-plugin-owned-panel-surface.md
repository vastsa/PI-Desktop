# ADR 0092: Use a plugin-owned surface with a host window-control capsule

- Status: Accepted
- Date: 2026-08-17
- Related: D234, ADR 0081, ADR 0082

## Context

The first plugin-panel chrome revision made the host render a full titlebar,
kept native traffic lights on macOS while giving Windows and Linux a flat
control band, and drew the manifest title plus a development reminder. That
chrome owns the visual hierarchy of a panel, so authors cannot build their own
toolbar without competing with the host.

## Decision

Plugin panels use frameless windows on every platform without native traffic
lights or panel menus, and the sandboxed preload reserves a transparent 46px
safe area holding one fixed top-right capsule with minimize,
maximize/restore, and close. The plugin owns its title, toolbar, background, and
content, with normal-flow content offset automatically, fixed or sticky UI
anchored to `--pi-plugin-titlebar-height: 46px`, and drag regions opted into
through `-webkit-app-region: drag` with interactive children opting out. The
capsule stays in a closed preload-owned Shadow DOM behind a sender-validated
private window-control channel, and `window.pluginBridge` gains no window
primitives.

## Consequences

- Every platform shows the same compact control grammar while the plugin owns
  its entire visible header.
- The 46px safe area remains a stable layout contract for panels and fixed
  toolbars, while the manifest title survives only as window identity.
- Documentation must teach the safe-area variable and the drag-region contract.

## Alternatives

- Keep native macOS controls plus a host titlebar: rejected, it preserves the
  platform split and spends the plugin's hierarchy on host chrome.
- Expose window controls to the plugin bridge: rejected, plugin JavaScript
  needs no generic native-window authority.
