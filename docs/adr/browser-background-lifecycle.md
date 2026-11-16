# ADR: Browser page execution outlives side-panel presentation

- Status: Accepted
- Date: 2026-10-17
- Amends: [ADR 0170](0170-work-panel-browser-as-bundled-plugin.md) and
  [retained resource pages](retained-browser-pages-per-tab.md)

## Context

Main already retains one BrowserPane and CDP session per conversation/resource
page. Tool execution nevertheless depended on the shared visible browser chrome,
and the bundled Browser tool called `reveal()` before every action.

## Decision

Main owns live pages and their execution. The renderer owns only presentation:
measured bounds, visible page selection and side-panel tabs.

- Every tool API derives its session from the trusted in-flight invocation and
  resolves that session's connected page.
- Navigation starts immediately in Main, including in background conversations.
- Background page metadata updates the originating renderer context.
- Unknown/closed targets fail with `UNAVAILABLE`.
- Explicit `reveal()` remains a presentation API with its existing visible-view
  acknowledgement.
- Hidden pages are parked in a lazy, invisible sandboxed BrowserWindow owned by
  BrowserBackingHost, keeping Chromium's render/input widget connected while the
  side-panel container is unmounted.
- Host-only focus emulation and page-relative target coordinates make background
  input reliable without native focus or extending the public raw-CDP allowlist.
- Renderer reload hides and detaches presentation, not pages.
- Explicit tab/session closure, plugin disable/unload, window destruction and
  app shutdown release the corresponding pages, debugger state and watchers.

The process model, browser plugin contract, URL/file-root gates, permission
checks, raw-CDP allowlist, cookie partition, tool modes and screenshot deadlines
remain unchanged. There is no database migration or restart DOM persistence.

## Alternatives

Keeping the visibility dependency forces users to babysit a background task.

## Consequences

Users can collapse the side panel, view another conversation or Settings, and
reload the shell while the original browser remains usable.
