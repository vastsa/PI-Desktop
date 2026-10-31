# ADR 0328: Open arbitrary local files in the embedded Browser

- Status: Accepted
- Date: 2026-10-13
- Deciders: PI-Desktop core
- Related: issue #1627 · [ADR 0170](0170-work-panel-browser-as-bundled-plugin.md) ·
  [ADR 0028](0028-session-scoped-work-panel-contexts.md)

## Context

The embedded Browser accepted only files below the active session workspace.
That restriction also blocked a user from opening an existing local HTML file
by absolute path or `file:` URL, and prevented local pages from following links
to files elsewhere on the machine. `BrowserPreview` and the runtime sidecar
also use workspace-rooted path validation, but those agent-facing file tools
must keep their current scope.

## Decision

1. The embedded Browser accepts an absolute path or `file:` URL for any existing
   regular local file. Relative address-bar paths remain rooted in the current
   session workspace.
2. A local-file page may navigate to other existing local files. HTTP(S) pages
   keep the prior in-workspace file-link allowance and cannot navigate to files
   outside that workspace.
3. File URLs with a remote authority, missing paths, directories, and other
   unsupported schemes remain blocked. Popups still open externally only for
   the existing `http:`, `https:`, and `mailto:` allowlist.
4. The public `pi.browser.navigate` API receives the same local-file behavior
   under the high-risk `browser.cdp` permission. `BrowserPreview` and the
   sidecar continue to use `resolveLocalFile()` and remain workspace-scoped.

## Consequences

- Users can preview local HTML and related files outside the project from the
  Browser address bar.
- A plugin granted `browser.cdp` can navigate the visible Browser to an
  explicitly supplied local path and inspect its page through the existing
  browser API. The Browser remains a sandboxed `WebContentsView` with Node
  integration disabled, context isolation enabled, and permission requests
  denied; access to local content is still a high-risk capability.
- A remote web page cannot use a top-level file link to escape the session
  workspace. Workspace-relative paths, BrowserPreview validation, and the
  runtime sidecar file boundary are unchanged.
- No IPC schema, persisted state, or user setting changes.

## Alternatives considered

### Allow address-bar entry but keep local-page links workspace-scoped

Rejected because a local HTML page can reference or link to sibling files
outside the project, which is the same preview workflow the Browser already
supports within a workspace.

### Add a separate opt-in toggle

Rejected because issue #1627 explicitly asks the Browser to stop imposing the
workspace boundary. Address-bar navigation remains an explicit user action;
programmatic navigation remains guarded by the existing high-risk permission.
