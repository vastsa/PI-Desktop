# ADR 0081: Host-owned cross-platform plugin panel chrome

- Status: Accepted
- Date: 2026-08-13
- Deciders: PI-Desktop core
- Related: D118, D129, D218, ADR 0021, ADR 0025

## Context

Plugin panels run in separate sandboxed `BrowserWindow` instances and load
plugin-owned HTML. Those windows previously used Electron's default frame, so
their titlebar did not match the main PI-Desktop window and differed materially
between macOS, Windows, and Linux.

## Decision

1. Plugin panels use the same platform split as the main window: macOS uses
   `hiddenInset` with traffic lights at `{x:16,y:16}`, while Windows and Linux
   use a frameless window with renderer-drawn controls.
2. The existing sandboxed plugin-panel preload installs a host-owned 46px
   titlebar in a closed Shadow DOM.
3. Windows/Linux expose minimize, maximize/restore, and close through one
   Electron-local fixed action tuple.
4. The public `window.pluginBridge` surface does not gain window primitives.
5. Controls carry localized accessible names, visible keyboard focus, theme-
   aware light/dark surfaces, and reduced-motion behavior.
6. Development panels receive a host-only titlebar reminder for the 46px safe
   area.

## Consequences

- Plugin panels visually align with the main application chrome on all three
  release platforms without granting plugins broader Electron access.
- Plugin CSS cannot style the closed titlebar tree, although a plugin can still
  replace its own document and therefore remove the preload-injected visual
  element.
- The host reserves 46px above plugin content.
- The private window-control channel remains outside host-core protocol v9.

## Alternatives

### Keep Electron's default panel frame

Rejected because it preserves inconsistent product chrome and leaves
Windows/Linux panels visually detached from the main application.

### Expose the main window-control API to plugin JavaScript

Rejected because the plugin bridge should remain limited to declared plugin
capabilities and must not acquire generic native-window authority.

### Host plugin content inside the main renderer DOM

Rejected because it would weaken the existing separate-window, separate-
partition isolation model for a visual-only change.

## References

- `docs/spec/03-runtime/01-ipc-protocol.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-024D)
- `docs/spec/07-plugins/01-plugin-system.md`
- `docs/spec/07-plugins/04-plugin-security.md`
