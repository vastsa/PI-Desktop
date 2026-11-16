# ADR 0025: Keep Application Menus out of Windows/Linux Windows

- Status: Accepted
- Date: 2026-07-27
- Deciders: PI-Desktop core
- Related: D118, D129, ADR 0021

## Context

ADR 0021 introduced a native macOS system menu and a renderer-owned
File/Edit/View/Window/Help menubar inside Windows/Linux windows. The in-window
menubar consumes the left side of the 46px titlebar and applies a macOS menu
model to frameless Windows/Linux chrome.

## Decision

1. macOS keeps the conventional native Electron application menu and
   hidden-inset traffic lights defined by ADR 0021.
2. Windows/Linux keep the frameless 46px titlebar and renderer-drawn minimize,
   maximize/restore, and close controls, but render no application menubar
   inside the window.
3. Windows/Linux titlebar navigation reclaims the space previously reserved for
   File/Edit/View/Window/Help.
4. Common Windows/Linux application, close-window, zoom, and fullscreen
   shortcuts are handled without a visible menu.
5. Existing allowlisted menu-command and native-action IPC stays in place for
   the macOS system menu, renderer readiness, and shortcut dispatch.

## Consequences

- The window titlebar is quieter and gives navigation the full left edge.
- macOS retains the platform-standard system menu and all native roles.
- Windows/Linux users rely on visible in-app controls, Settings -> Info, the
  command palette, and keyboard shortcuts instead of an in-window menubar.
- F10 and Shift+F10 are no longer consumed by renderer shell chrome.
- The removed renderer menubar component, styling, focus model, and localized
  popover behavior no longer require maintenance or qualification.

## Alternatives

### Keep the renderer menubar but hide it by default

Rejected because an Alt/F10-revealed menu still reserves a platform concept that
product direction does not want inside the window.

### Remove all menu-related IPC

Rejected for this change because the macOS system menu still dispatches
allowlisted renderer commands, and Windows/Linux shortcuts can reuse the bounded
native-action surface without broadening Main-process authority.

## References

- `docs/adr/0021-platform-application-chrome.md`
- `docs/spec/03-runtime/01-ipc-protocol.md`
- `docs/spec/04-ux/01-ui-ia.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/04-ux/09-interaction-patterns.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-067)
- `docs/spec/08-meta/decisions-log.md` (D129)
