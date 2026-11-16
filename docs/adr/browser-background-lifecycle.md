# ADR: Browser page execution outlives side-panel presentation

- Status: Accepted
- Date: 2026-10-17
- Amends: [ADR 0170](0170-work-panel-browser-as-bundled-plugin.md) and
  [retained resource pages](retained-browser-pages-per-tab.md)

## Context

Main already retains one BrowserPane and CDP session per conversation or resource
page, but tool execution depended on the shared visible browser chrome and the
bundled Browser tool called `reveal()` before every action, so collapsing the
side panel or switching conversations made a retained page unusable, and a
renderer reload disposed every guest.

## Decision

Main owns live pages and their execution; the renderer owns only presentation —
measured bounds, visible page selection, and side-panel tabs.

- Every tool API derives its session from the trusted in-flight invocation and
  resolves that session's connected page, never another conversation's visible
  page; a first navigation or BrowserPreview establishes the connection.
- Navigation starts immediately in Main, including in background conversations,
  and continuing operations never reopen a collapsed panel or steal focus.
- Background metadata updates only its originating renderer context, an unknown
  or closed target fails with `UNAVAILABLE`, and explicit `reveal()` stays a
  presentation API with its visible-view acknowledgement.
- Hidden pages are parked in a lazy, invisible sandboxed BrowserWindow owned by
  BrowserBackingHost, so Chromium keeps its render and input widget while the
  side-panel container is unmounted; showing a page moves that same native view
  back to the measured hole.
- Host-only focus emulation and page-relative target coordinates make background
  input reliable without extending the public raw-CDP allowlist.
- Renderer reload hides and detaches presentation, not pages: the additive,
  session-filtered `browser/getPages` IPC restores missing tabs without reopening
  the panel or replacing a user-selected resource.
- Explicit tab or session closure, plugin disable, window destruction, and
  shutdown release the corresponding pages, debugger state, and watchers.

The process model, plugin contract, URL and file-root gates, permissions, cookie
partition, tool modes, and screenshot deadlines are unchanged, with no database
migration or restart DOM persistence.

## Consequences

- Users can collapse the panel, switch conversations, and reload the shell while
  the browser stays usable.
- Memory stays allocated until the page's explicit owner closes it, and restart or
  guest-crash recovery does not promise unsaved DOM.

## Alternatives

- Keep the visibility dependency: rejected; it forces users to babysit a
  background task.
- Address the current visible page globally: rejected; it permits accidental
  cross-session reads and actions.
