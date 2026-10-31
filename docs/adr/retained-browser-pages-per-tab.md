# ADR: Retain a host-owned browser page per resource tab

- Status: Accepted
- Date: 2026-09-26
- Supersedes: ADR 0170 clause 6 (singleton guest)

## Context

Browser resource tabs initially retained addresses but shared one guest. Switching
reloaded pages and discarded form/scroll/JavaScript state. Mixing session-only
navigation with tab addresses also allowed BrowserPreview to overwrite the active
tab, background navigation to lose its destination, and empty tabs to expose old
state. The requested behavior is to keep each open tab's live page.

## Decision

Electron Main's BrowserHost owns pages keyed by session id and tab id. Each page
owns its BrowserPane, CDP state, navigation generation, and current browser state.
Only the selected page is attached to the measured browser hole; hidden pages
retain their WebContents and use Chromium background throttling. The browser
partition and existing URL, permission, file-root and CDP allowlists stay intact.

BrowserPreview validates the request and asks BrowserHost to create and load a
new resource page before its renderer tab mounts. Background browser.navigate
runs immediately in its session's connected page. Presentation selection and
the tool connection are independent; see [background lifecycle](browser-background-lifecycle.md).
An empty tab has no inherited native page state. Bundled browser chrome tags
its navigation/action requests with the owning session/tab; a delayed reply
cannot repaint another tab. Agent-facing methods retain runtime-owned session
identity rather than accepting these UI routing fields.

Closing a tab releases its page and CDP state. Session deletion, plugin disposal,
window destruction and application shutdown release the corresponding pages.
Renderer reload now only detaches presentation; Main retains pages and exposes
their metadata for restoring side-panel tabs. Application restart does not
persist arbitrary DOM, and page crashes do not promise unsaved-form recovery.

## Alternatives

Keeping one guest and saving only URLs cannot preserve live page state. Saving
and restoring arbitrary DOM/JavaScript state is not a reliable substitute for a
retained WebContents. Automatic suspension with serialized navigation state is
possible later, but needs explicit recovery and unsaved-input handling.

## Consequences

Normal tab switching preserves forms, scroll position and per-tab navigation
history without issuing another load. Memory usage grows with open pages; users
release that memory by closing tabs. No database schema or plugin permission is
added. Independent page ownership prevents stale work from changing another tab.
