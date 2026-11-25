# ADR 0328: Open arbitrary local files in the embedded Browser

- Status: Accepted
- Date: 2026-10-13
- Related: [ADR 0170](0170-work-panel-browser-as-bundled-plugin.md) · [ADR 0028](0028-session-scoped-work-panel-contexts.md) · issue #1627

## Context

The embedded Browser accepted only files below the active session workspace, which
blocked opening a local HTML file by absolute path or `file:` URL and stopped local
pages from following links to files elsewhere on the machine. `BrowserPreview` and
the runtime sidecar also validate workspace-rooted paths, but those agent-facing
tools must keep their scope.

## Decision

The embedded Browser accepts an absolute path or `file:` URL for any existing
regular local file, while relative address-bar paths stay rooted in the session
workspace. A local-file page may navigate to other existing local files, whereas
HTTP(S) pages keep the in-workspace file-link allowance. File URLs with a remote
authority, missing paths, directories, and unsupported schemes remain blocked, and
popups still open externally only for `http:`, `https:`, and `mailto:`. The public
`pi.browser.navigate` API gets the same behavior under the high-risk `browser.cdp`
permission, while `BrowserPreview` and the sidecar keep using `resolveLocalFile()`
with workspace scope.

## Consequences

- Users can preview local HTML and its sibling files outside the project from the
  address bar.
- A plugin granted `browser.cdp` can navigate and inspect a supplied local path, so
  local content stays high-risk even though the Browser remains a sandboxed
  `WebContentsView` with Node integration disabled.
- A remote page still cannot escape the workspace by link, and no IPC schema,
  persisted state, or setting changes.
