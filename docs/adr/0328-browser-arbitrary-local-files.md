# ADR 0328: Open arbitrary local files in the embedded Browser

- Status: Accepted
- Date: 2026-10-13
- Deciders: PI-Desktop core
- Related: issue #1627 · [ADR 0170](0170-work-panel-browser-as-bundled-plugin.md) ·
  [ADR 0028](0028-session-scoped-work-panel-contexts.md)

## Context

The embedded Browser accepted only files below the active session workspace.
That restriction also blocked a user from opening an existing local HTML file by
absolute path or `file:` URL, and prevented local pages from following links to
files elsewhere on the machine.

## Decision

1. The embedded Browser accepts an absolute path or `file:` URL for any existing
   regular local file.
2. A local-file page may navigate to other existing local files.
3. File URLs with a remote authority, missing paths, directories, and other
   unsupported schemes remain blocked.
4. The public `pi.browser.navigate` API receives the same local-file behavior
   under the high-risk `browser.cdp` permission.

## Consequences

- Users can preview local HTML and related files outside the project from the
  Browser address bar.
- A plugin granted `browser.cdp` can navigate the visible Browser to an
  explicitly supplied local path and inspect its page through the existing
  browser API.
- A remote web page cannot use a top-level file link to escape the session
  workspace.
- No IPC schema, persisted state, or user setting changes.

## Alternatives considered

### Allow address-bar entry but keep local-page links workspace-scoped

Rejected because a local HTML page can reference or link to sibling files
outside the project, which is the same preview workflow the Browser already
supports within a workspace.

### Add a separate opt-in toggle

Rejected because issue #1627 explicitly asks the Browser to stop imposing the
workspace boundary.
