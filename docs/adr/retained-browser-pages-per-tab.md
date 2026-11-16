# ADR: Retain a host-owned browser page per resource tab

- Status: Accepted
- Date: 2026-09-26
- Supersedes: ADR 0170 clause 6 (singleton guest)

## Context

Browser resource tabs retained addresses but shared one guest, so switching reloaded
pages and discarded form, scroll, and JavaScript state, while mixing session-only
navigation with tab addresses let `BrowserPreview` overwrite the active tab and
exposed old state in empty tabs.

## Decision

Electron Main's `BrowserHost` owns pages keyed by session id and tab id. Each page
owns its `BrowserPane`, CDP state, navigation generation, and browser state; only
the selected page attaches to the measured browser hole, and hidden pages keep
their `WebContents` under background throttling. The browser partition and existing
URL, permission, file-root, and CDP allowlists stay intact. `BrowserPreview` asks
`BrowserHost` to create and load a resource page before its renderer tab mounts, and
background `browser.navigate` runs in its session's connected page, so presentation
and the tool connection are independent (see
[background lifecycle](browser-background-lifecycle.md)). Bundled chrome tags
requests with the owning session and tab, so a delayed reply cannot repaint another
tab. Closing a tab releases its page and CDP state, as do session deletion, plugin
disposal, and shutdown; a renderer reload only detaches presentation while Main
keeps the pages for restoring side-panel tabs.

## Consequences

- Tab switching preserves forms, scroll position, and per-tab history without
  another load, and stale work cannot change another tab.
- Memory grows with open pages and is released by closing tabs.
- Restart persists no arbitrary DOM and a crash does not promise unsaved-form
  recovery; no schema or plugin permission is added.
