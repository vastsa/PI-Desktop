# ADR 0076: Capture the Windows-reserved plugin launcher chord in host-core

- Status: Accepted
- Date: 2026-08-12
- Related: D211, ADR 0072, E2E-120

## Context

Windows reserves `Alt+Space` for the active window's system menu, so Electron's
`globalShortcut` may reject the launcher's default binding.

## Decision

Host-core installs a narrow Windows `WH_KEYBOARD_LL` hook for the default
`Alt+Space` binding, consumes the keydown, and emits `keyboard.shortcut` over the
existing JSON-RPC notification transport; `keyboard.setGlobalShortcut` enables the
hook only while that binding is effective on Windows, and other platforms and
custom bindings keep Electron's global shortcut path. The hook reads no text,
grants no capability, and leaves the focused-window fallback in place on failure.

## Consequences

- The default chord works while another application is foregrounded.
- One small host-side platform integration; no protocol or schema change.
