# ADR 0170: Ship the work-panel browser as a bundled plugin over public CDP

- Status: Accepted
- Date: 2026-09-06
- Deciders: PI-Desktop core
- Related: [ADR 0019](0019-work-panel-subsystems.md) ·
  [ADR 0104](0104-plugin-contributed-work-panel-views.md) ·
  [ADR 0105](0105-files-as-a-bundled-plugin.md) ·
  [07-plugins](../spec/07-plugins/README.md)

## Context

The work-panel browser was a host-built launcher row (`HEADER_TOOLS`) plus a
Main-owned `WebContentsView` guest, while Files already proved a first-party surface
can ship as a bundled plugin on the public `contributes.views` channel — enabled or
disabled on the Plugins page, never uninstallable.

The plugin page cannot *be* the browser: plugin views are sandboxed, have
`webviewTag: false`, and are confined by `net.domains`, so arbitrary http(s),
workspace files, and Chrome DevTools Protocol must stay on a host-owned guest.

## Decision

1. **`pi.browser` is a bundled plugin** in `apps/desktop/resources/plugins/`,
   enabled by default, disableable, not uninstallable. It contributes view `browser`
   (icon token `browser`, order 10) and registers the agent tool `Browser`.
2. **The guest `WebContentsView` (`persist:work-browser`) and debugger stay
   host-owned.** Plugin chrome is a normal plugin view, and the guest is stacked on a
   content-relative hole the chrome reports through `pi.browser.setBounds`.
3. **`browser.cdp` is a public high-risk permission** and `pi.browser.*` a public
   host API, with raw CDP allowlisted and deny-by-default (cookie, storage, target,
   and network-interception methods refused, no DevTools websocket), and bounds
   clamped to the calling plugin view.
4. **Host `BrowserPreview` remains a thin facade** for Plan/subagent name stability:
   it errors when `pi.browser` is disabled, otherwise loading the workspace file into
   a session-owned guest. [Background browser pages](browser-background-lifecycle.md)
   supersedes the visible-before-operation rule and
   [retained browser pages per tab](retained-browser-pages-per-tab.md) replaces the
   singleton guest with one page per session and tab.

This supersedes ADR 0105 clause 4, the host-launcher clause of ADR 0019, and
ADR 0108's "Browser as the host-built tool" clause; guest ownership and navigation
policy are unchanged.

## Consequences

- Disabling `pi.browser` removes the launcher row, agent CDP, and guest, URL chips
  fall back to `openExternal`, and `BrowserPreview` fails closed.
- `browser.cdp` tools address their invoking session's connected page, and Plan keeps
  `BrowserPreview` with the four `planSafeActions` (`navigate`, `snapshot`,
  `screenshot`, `console`) Plan/Goal-safe while click/fill/evaluate/cdp stay
  Agent-only (ADR 0211).

## Alternatives

- Load the page inside the plugin view: needs `webviewTag`, a wildcard
  `net.domains`, and CDP on the wrong WebContents.
- Private host APIs only `pi.browser` may call: Files proved the public channel.
- Keep React `BrowserTab` chrome and only plugin-ize the launcher: that is not a
  browser shipped as a plugin.
