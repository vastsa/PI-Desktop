# ADR: Browser page execution outlives side-panel presentation

- Status: Accepted
- Date: 2026-10-17
- Amends: [ADR 0170](0170-work-panel-browser-as-bundled-plugin.md) and
  [retained resource pages](retained-browser-pages-per-tab.md)

## Context

Main already retains one BrowserPane and CDP session per conversation/resource
page. Tool execution nevertheless depended on the shared visible browser chrome,
and the bundled Browser tool called `reveal()` before every action. Switching
conversations or collapsing the side panel therefore made a retained page
unusable. Renderer reload also disposed every guest, discarding live forms.

Moving the browser elsewhere would not remove those dependencies. The requested
layout keeps it in the side panel while making execution independent of UI
mounting and visibility.

## Decision

Main owns live pages and their execution. The renderer owns only presentation:
measured bounds, visible page selection and side-panel tabs.

- Every tool API derives its session from the trusted in-flight invocation and
  resolves that session's connected page. It never falls back to another
  conversation's visible page. A first navigation or BrowserPreview establishes
  a connection; viewing another tab does not change an established connection.
- Navigation starts immediately in Main, including in background conversations.
  BrowserPreview creates a new host page before requesting its renderer tab.
  Continuing operations do not reopen a collapsed panel or steal focus.
- Background page metadata updates the originating renderer context. The shared
  plugin chrome receives only presentation-selected page state, so background
  navigation cannot repaint another page or alter its native bounds.
- Unknown/closed targets fail with `UNAVAILABLE`. A new navigation or preview can
  establish a new connection; arbitrary cross-session sharing is not introduced.
- Explicit `reveal()` remains a presentation API with its existing visible-view
  acknowledgement. Unscoped plugin UI calls keep their visible-page boundary.
- Hidden pages are parked in a lazy, invisible sandboxed BrowserWindow owned by
  BrowserBackingHost, keeping Chromium's render/input widget connected while the
  side-panel container is unmounted. Showing a page moves its same native view
  back to the measured side-panel hole; neither a new visible window nor a second
  page is created. The backing window is released when no parked pages remain.
- Host-only focus emulation and page-relative target coordinates make background
  input reliable without native focus or extending the public raw-CDP allowlist.
  Pointer/capture work shares a page-local viewport queue and restores throttling
  and pending bounds after success, failure or timeout.
- Renderer reload hides and detaches presentation, not pages. An additive,
  session-filtered `browser/getPages` IPC returns BrowserState metadata; the
  renderer restores missing tabs without reopening the panel or replacing a
  user-selected resource. Stale restore results are discarded.
- Explicit tab/session closure, plugin disable/unload, window destruction and
  app shutdown release the corresponding pages, debugger state and watchers.

The process model, browser plugin contract, URL/file-root gates, permission
checks, raw-CDP allowlist, cookie partition, tool modes and screenshot deadlines
remain unchanged. There is no database migration or restart DOM persistence.

## Alternatives

Keeping the visibility dependency forces users to babysit a background task.
Making all plugin calls globally address the current page would permit accidental
cross-session reads and actions. Moving the browser to a new window would add a
presentation lifecycle without solving either issue.

## Consequences

Users can collapse the side panel, view another conversation or Settings, and
reload the shell while the original browser remains usable. Memory stays allocated
until its explicit owner closes it; restart and guest-crash recovery do not promise
unsaved DOM preservation. Tests cover real BrowserHost/CDP wiring, plugin process
identity, renderer tab restoration and isolated Chromium input/screenshots.
