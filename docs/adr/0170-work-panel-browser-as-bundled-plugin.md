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

## Decision

1. **`pi.browser` is a bundled plugin** in `apps/desktop/resources/plugins/`,
   enabled by default, disableable, not uninstallable.
2. **The guest `WebContentsView` (`persist:work-browser`) and debugger stay
   host-owned.** Plugin chrome is a normal plugin view.
3. **`browser.cdp` is a public permission** (high).
4. **Raw CDP is allowlisted and deny-by-default.** Cookie, storage, target, and
   network-interception methods are refused.
5. **Host `BrowserPreview` remains a thin facade** (Plan/subagent name
   stability).
6. The original singleton guest decision is superseded by [Retain a host-owned
   browser page per resource tab](retained-browser-pages-per-tab.md).

This supersedes ADR 0105 clause 4 (Browser remains a host-built launcher) and
the host-launcher clause of ADR 0019. Guest ownership and navigation policy are
unchanged.

## Consequences

- Disabling `pi.browser` removes the launcher row, agent CDP, and guest.
- Tools with `browser.cdp` address their invoking session's connected page;
  unscoped plugin UI calls still require the current visible Browser view.
- Plan still sees `BrowserPreview`.

## Alternatives considered

### Load the web page inside the plugin view

Rejected: would require `webviewTag`, a wildcard `net.domains`, and attaching
CDP to the wrong WebContents.

### Private host APIs only `pi.browser` may call

Rejected: the Files bar is that first-party features prove the public channel.

### Keep React `BrowserTab` chrome and only plugin-ize the launcher

Rejected: that is not “the whole default browser is a plugin.”
