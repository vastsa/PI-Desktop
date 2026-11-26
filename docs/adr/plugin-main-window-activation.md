# Explicit plugin activation of the desktop main window

- Status: Implemented candidate
- Related: [ADR 0203](0203-local-mcp-control-plane.md), [ADR 0208](0208-plugin-desktop-control-native-consent.md)

## Context

A hardware-control plugin can select a session without interrupting the user's
foreground application. The same device may also offer a distinct explicit
reveal gesture. Session navigation should not implicitly request focus, and an
out-of-process plugin does not own the Electron main window.

## Decision

Offer a parameterless `window/activate` write operation to plugins granted
`desktop.control`. It is dispatched inside Electron main, targets only the
host-selected main window and is absent from both renderer IPC and local MCP.
The invocation returns Electron's observed focus, not a guarantee of OS focus.
Keep this independent of `session/open`; plugins call activation only for an
explicit user action.

## Consequences

Trusted plugins need neither window handles nor OS input injection for the
activation request. Windows may still deny foreground focus. No existing
navigation, external control or permission contract changes.
