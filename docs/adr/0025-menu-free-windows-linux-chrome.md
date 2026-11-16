# ADR 0025: Keep Application Menus out of Windows/Linux Windows

- Status: Accepted
- Date: 2026-07-27
- Related: D118, D129, ADR 0021

## Context

ADR 0021 applied a macOS menu model to frameless chrome and gave Windows/Linux
windows a renderer-owned File/Edit/View/Window/Help menubar. The menu surface now
stays specific to the macOS system menu, while Windows/Linux still need window
controls and access to common commands.

## Decision

macOS keeps the native Electron application menu and the hidden-inset traffic
lights from ADR 0021. Windows/Linux keep the frameless titlebar and
renderer-drawn minimize, maximize/restore, and close controls but render no
menubar, and titlebar navigation reclaims that space. Common application,
close-window, zoom, and fullscreen shortcuts work without a visible menu, while
standard editing shortcuts stay native web content. The allowlisted menu-command
and native-action IPC stays for the macOS menu, renderer readiness, and shortcut
dispatch, adding no privileged surface.

## Consequences

- Titlebar space goes to navigation; F10 / Shift+F10 are no longer consumed by
  renderer shell chrome.
- Windows/Linux users reach commands through in-app controls, Settings -> Info,
  the command palette, and shortcuts.
- The removed menubar component, styling, focus model, and localized popovers
  need no maintenance.

## Alternatives

- Hide the menubar by default: an Alt/F10-revealed menu still reserves the concept
  in-window.
- Remove all menu IPC: the macOS menu still dispatches allowlisted commands.
