# ADR 0021: Platform application chrome

- Status: Superseded in part by ADR 0025
- Date: 2026-07-26

## Context

Electron's default chrome does not satisfy all three desktop conventions used by
PI-Desktop. macOS needs a conventional native application menu and inset traffic
lights. Frameless Windows and Linux windows need visible application menus plus
minimize, maximize/restore, and close controls.

## Decision

1. macOS keeps `hiddenInset` traffic lights and installs a native Electron
   application menu.
2. Windows and Linux use the shared frameless 46px shell with a renderer menubar
   and renderer-drawn window controls.
3. Renderer-owned menu commands use the fixed `APP_MENU_COMMANDS` allowlist.
4. The preload exposes only the operating-system identifier and allowlisted IPC
   channels required by the chrome.
5. Native commands wait for a renderer-ready acknowledgement before delivery.
6. Windows and Linux packaging remains shell-readiness work.

## Consequences

- Each platform receives familiar menus and window controls without exposing
  arbitrary Main-process execution.
- A native menu command can recreate the macOS window without racing renderer
  subscription setup or creating duplicate windows.
- Windows and Linux require native-runner packaging and visual qualification
  before release.
- Custom chrome must preserve keyboard, focus, localization, drag-region, and
  maximize-state behavior across renderer reloads.

## Alternatives

### Keep Electron's default menu and frame everywhere

Rejected because the existing hidden titlebar design would remain incomplete on
Windows and Linux, while macOS would lack product-specific commands.

### Implement every menu action in the renderer

Rejected because native editing and window operations belong to Electron Main
and must remain behind an explicit capability boundary.

### Send commands after a fixed delay

Rejected because renderer subscription timing varies by machine and reload
state.

## References

- `docs/spec/03-runtime/01-ipc-protocol.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/04-ux/09-interaction-patterns.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-067)
- `docs/spec/08-meta/decisions-log.md` (D118)
