# ADR 0021: Platform application chrome

- Status: Superseded in part by ADR 0025
- Date: 2026-07-26
- Related: D010, D118

## Context

Electron's default chrome fits none of the three desktop conventions PI-Desktop
needs: macOS wants a native application menu and inset traffic lights, while
frameless Windows and Linux windows want visible application menus plus window
controls. Renderer-owned commands such as New Task cannot run in Main directly,
and native editing, zoom, fullscreen, and window operations must not become an
arbitrary privileged command bridge.

## Decision

1. macOS keeps `hiddenInset` traffic lights and installs a native Electron
   application menu.
2. Windows and Linux use the shared frameless shell with a renderer menubar and
   renderer-drawn window controls.
3. Renderer-owned menu commands pass through the fixed `APP_MENU_COMMANDS`
   allowlist; native menu and window operations use separate fixed allowlists.
4. The preload exposes only the OS identifier and the allowlisted IPC channels the
   chrome needs.
5. Native commands wait for a renderer-ready acknowledgement before delivery,
   window creation is single-flight, and closing or reloading resets the
   acknowledgement.
6. Windows and Linux packaging remains shell-readiness work and does not change
   the macOS-arm64 first-release scope in D010.

## Consequences

- Each platform gets familiar menus and window controls without arbitrary
  Main-process execution.
- A native command can recreate the macOS window without racing renderer
  subscription or duplicating windows.
- Windows and Linux need native-runner packaging and visual qualification, and
  custom chrome must keep keyboard, focus, localization, drag-region, and
  maximize state across reloads.

## Alternatives

- Keep Electron's default menu and frame everywhere: rejected because the hidden
  titlebar design would stay incomplete and macOS would lack product commands.
- Send commands after a fixed delay: rejected because subscription timing varies,
  while an acknowledgement is deterministic.
