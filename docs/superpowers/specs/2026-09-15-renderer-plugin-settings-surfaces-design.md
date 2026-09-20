# Renderer Plugin Settings Surfaces Design

## Problem

`contributes.settingsDestinations` currently opens each plugin page in an
Electron `WebContentsView`. On Windows and Linux that child native surface is
always composited above the main renderer and has an opaque backing canvas.
Even when the plugin document and its CSS are transparent, it cannot reveal a
scenic backdrop painted by the main renderer. The result is the black rectangle
visible behind Nexus Scenic Themes.

The rectangle cannot be corrected with plugin theme CSS: it is outside the
document's compositor. Making the BrowserWindow transparent would risk native
resize, drag, and Windows/Linux window-control behaviour, and duplicating the
backdrop inside the child view would create an unsynchronised second canvas.

## Decision

Settings destinations will become renderer-composited sandboxed iframe
surfaces. The host renderer owns their location in the existing Settings layout;
plugins supply only their page files and communicate through a host-controlled
message bridge.

The existing native `PluginViewHost` remains the implementation for work-panel
views. It is not used for Settings destinations.

## Resource model

The main process will register a secure, standard `plugin-settings:` protocol
before `app.whenReady()`. A URL has the shape:

```
plugin-settings://<plugin-id>/<plugin-relative-entry-or-resource>
```

The handler resolves a resource only when all of the following hold:

1. `<plugin-id>` is currently loaded and has the granted `ui.settings`
   permission.
2. The requested path remains inside that plugin's package.
3. The package has a declared Settings destination whose resolved entry is in
   the same package.
4. The resource extension is one of the host's static page formats (HTML, CSS,
   JavaScript, image, font, or media) and has a known MIME type.

The handler answers with `no-store`, `nosniff`, and a host-authored CSP. The CSP
permits only same-origin scripts/styles/images/fonts plus declared
`plugin-asset:` images; it denies network connection, framing of other pages,
objects, workers, form submission, and navigation. This preserves the no-egress
contract even though an iframe shares the app BrowserWindow's Electron session.

The HTML entry receives one host-authored bridge script before plugin scripts.
It does not receive Node, Electron, the main renderer's preload bridge, or a
same-origin relationship with the host page.

## Bridge model

The embedded page receives `window.pluginBridge` with the same public shape as
today's panel bridge:

```ts
window.pluginBridge.invoke(channel, payload?)
window.pluginBridge.on(event, handler)
```

The bridge is implemented by an injected host script and `postMessage`, not by
a preload. The host React component accepts messages only from its own iframe
window, validates the message envelope and generated request id, and forwards
the call through a new main-process IPC endpoint. Main validates the active
plugin/destination, then calls the existing `PluginRuntime.invokePanelBridge`.
Consequently the existing fixed channel, permission, auditing, and plugin
identity checks remain authoritative. A plugin cannot invoke renderer IPC,
touch the Settings React tree, choose another plugin/destination, or send a
cross-plugin request.

Host appearance and locale arrive in a one-way initial bridge message. Existing
sanctioned bridge events, including `appearance:changed`, are forwarded only to
the matching active destination.

## Lifecycle and layout

`PluginSettingsDestination` renders a single iframe in the existing
`.settings-content-inner` flow. It has no native bounds IPC and cannot cover
the titlebar, Windows/Linux controls, resize edges, sidebar, or Settings rail.
The iframe expands with its normal Settings content region; the outer renderer
keeps scroll ownership and normal Settings geometry.

Core navigation, plugin disable/uninstall/reload, an absent entry, and a failed
load remove the iframe and return the user to General. No `WebContentsView` is
created, cached, or attached for a Settings destination. The Settings page
therefore stays on the one renderer compositing plane as `.app-scenic-backdrop`.

## Security and compatibility

- `sandbox` is present on every Settings iframe. It includes only
  `allow-scripts`; it deliberately excludes `allow-same-origin`, popups,
  downloads, top navigation, forms, and pointer-lock.
- Plugin destination pages remain package-local. Remote requests, dynamic
  resource URLs, and arbitrary CSS/DOM injection remain unavailable.
- Plugin panels and work-panel views retain their isolated `WebContentsView`
  architecture; their geometry and bridge contracts do not change.
- Ordinary Settings and all non-plugin themes retain their existing DOM,
  layout, native control handling, and styling.
- The host does not make the BrowserWindow transparent and does not add a
  second scenic background to a plugin surface.

## Verification

Contract tests will demonstrate protocol registration and strict CSP, sandboxed
iframe ownership, absence of Settings `WebContentsView` calls, message source
and destination validation, lifecycle cleanup, and protected native geometry.
Focused build/type checks will accompany existing plugin-theme tests. Manual
verification will cover switching between core Settings and Nexus Scenic Themes
while each scenic theme is active, plus native title controls on Windows/Linux.
