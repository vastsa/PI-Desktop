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
Main-owned `WebContentsView` guest. Files already proved that a first-party
surface can ship as a bundled plugin on the public `contributes.views` channel.
Users also need the whole browser — chrome, preview, and agent CDP — to be
optional the same way: enable/disable on the Plugins page, never uninstallable.

The plugin page cannot *be* the browser. Plugin views are sandboxed, have
`webviewTag: false`, and are confined by `net.domains`. Arbitrary http(s) and
workspace files, plus Chrome DevTools Protocol, have to stay on a host-owned
guest.

## Decision

1. **`pi.browser` is a bundled plugin** in `apps/desktop/resources/plugins/`,
   enabled by default, disableable, not uninstallable. It contributes view
   `browser` (icon token `browser`, order 10) and registers the agent tool
   `Browser`.
2. **The guest `WebContentsView` (`persist:work-browser`) and debugger stay
   host-owned.** Plugin chrome is a normal plugin view. The guest is stacked on
   a content-relative hole the chrome reports through `pi.browser.setBounds`.
3. **`browser.cdp` is a public permission** (high). `pi.browser.*` is a public
   host API. Any plugin that declares the permission may call it. Bounds are
   clamped to the calling plugin view so a guest cannot cover chat/composer.
4. **Raw CDP is allowlisted and deny-by-default.** Cookie, storage, target, and
   network-interception methods are refused. No DevTools websocket is exposed.
5. **Host `BrowserPreview` remains a thin facade** (Plan/subagent name
   stability). It errors if `pi.browser` is disabled; otherwise it loads the
   workspace file into the guest when that session's chrome is visible and
   reveals the plugin view. Plugin CDP stays Agent-only (`plugin_*`).
6. **v1 is a singleton guest.** Session locations are remembered and rebound
   when the originating conversation's plugin tab is shown (D142). Background
   sessions do not steal the visible guest.

This supersedes ADR 0105 clause 4 (Browser remains a host-built launcher) and
the host-launcher clause of ADR 0019. Guest ownership and navigation policy
are unchanged. ADR 0108's "Browser as the host-built tool" clause is likewise
superseded: the panel's launchable surfaces are plugin views.

## Consequences

- Disabling `pi.browser` removes the launcher row, agent CDP, and guest. URL
  chips fall back to `openExternal`. `BrowserPreview` fails closed.
- Third-party plugins with `browser.cdp` share the same guest; last chrome
  `setBounds` wins.
- Plan still sees `BrowserPreview`. The Browser plugin tool is also visible in Plan/Goal for the four `planSafeActions` (`navigate`, `snapshot`, `screenshot`, `console`); click/fill/evaluate/cdp stay Agent-only (ADR 0211).

## Alternatives considered

### Load the web page inside the plugin view

Rejected: would require `webviewTag`, a wildcard `net.domains`, and attaching
CDP to the wrong WebContents.

### Private host APIs only `pi.browser` may call

Rejected: the Files bar is that first-party features prove the public channel.

### Keep React `BrowserTab` chrome and only plugin-ize the launcher

Rejected: that is not “the whole default browser is a plugin.”
