# ADR 0076: Capture the Windows-reserved plugin launcher chord in host-core

- Status: Accepted
- Date: 2026-08-12
- Deciders: PI-Desktop core
- Related: D211 · ADR 0072 · E2E-120

## Context

Windows reserves `Alt+Space` for the active window system menu. Electron's
`globalShortcut` may therefore reject the plugin launcher's default binding, and
a renderer `before-input-event` fallback only works while PI-Desktop is focused.

## Decision

Host-core installs a narrow Windows `WH_KEYBOARD_LL` hook for the default
`Alt+Space` binding. It consumes the matching keydown, emits the existing
JSON-RPC notification transport with `keyboard.shortcut`, and lets Electron
toggle the plugin launcher.

The hook does not inspect or persist text, and it does not expose a new renderer
or plugin capability. If hook installation fails, the focused-window fallback
remains available and the failure is logged.

## Consequences

- The default Windows launcher chord works while another application is
  foregrounded and does not open that application's system menu.
- The host binary owns a small platform-specific input integration, while
  Electron remains responsible for window creation and plugin-panel access.
- Protocol version and storage schema remain unchanged because the method and
  notification are additive and Electron is the only consumer.
