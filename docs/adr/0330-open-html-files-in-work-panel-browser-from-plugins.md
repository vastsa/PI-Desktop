# ADR 0330: Open scoped HTML files in the work-panel Browser from plugins

- Status: Accepted
- Date: 2026-10-16
- Deciders: PI-Desktop maintainers
- Related: [ADR 0109](0109-open-files-with-the-os-associated-application.md) ·
  [ADR 0170](0170-work-panel-browser-as-bundled-plugin.md) ·
  [ADR 0264](0264-host-mediated-actions-follow-the-browsed-folder.md) ·
  [ADR 0328](0328-browser-arbitrary-local-files.md) ·
  [07-plugins/03-plugin-api](../spec/07-plugins/03-plugin-api.md) · E2E-153

## Context

The bundled File Manager can open files with the OS application or reveal them
in the file manager. HTML previews need the bundled work-panel Browser, but its
public `pi.browser.*` API is gated by high-risk `browser.cdp` and also exposes
page inspection and control. That permission is broader than a file-tree
preview action needs.

## Decision

1. Add the additive `pi.fs.openInBrowser(pathFromRoot)` API and panel bridge
   channel `fs.openInBrowser`, covered by the existing `fs.read` permission.
2. Resolve the path with the same real-path, protected-path, credential
   deny-list, declared-scope, and project-group root checks as the other
   host-mediated file actions. Accept only existing regular `.html`, `.htm`, or
   `.xhtml` files, and audit successful and refused requests.
3. After validation, Electron Main sends a dedicated Browser-open event to the
   renderer. The renderer creates a Browser resource tab for the active local
   session. The bundled Browser plugin must be enabled; disabled Browser state
   fails with `UNAVAILABLE`.
4. This action does not grant `browser.cdp`, expose Browser actions or page
   contents, broaden `BrowserPreview`, or change the Browser's existing local
   file navigation policy (ADR 0328). No host-core protocol version or
   persisted data changes.

## Consequences

- A File Manager user can preview an authorized HTML file without leaving the
  work panel or granting the plugin Browser control.
- The Browser continues to apply its established policy for local HTML and
  linked local resources after the host has checked the file-tree selection.
- Plugins cannot use this API to open directories, non-HTML files, credentials,
  protected app data, or paths outside their declared read scope.

## Alternatives considered

### Grant `browser.cdp` to the File Manager

Rejected: that high-risk capability also permits page inspection and browser
actions, while this interaction only needs the host to open one scoped file.

### Reuse `BrowserPreview`

Rejected: `BrowserPreview` is workspace-rooted and session-originated. File
Manager also supports explicitly browsing another registered folder in a
project group, and its user-driven action needs to follow the selected file.

### Open through `shell.openExternal(file:)`

Rejected: external URL opening intentionally excludes local file URLs. A
separate scoped host action preserves that boundary.
