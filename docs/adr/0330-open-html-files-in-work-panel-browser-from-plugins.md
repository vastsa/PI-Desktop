# ADR 0330: Open scoped HTML files in the work-panel Browser from plugins

- Status: Accepted
- Date: 2026-10-16
- Related: [ADR 0109](0109-open-files-with-the-os-associated-application.md) ·
  [ADR 0170](0170-work-panel-browser-as-bundled-plugin.md) ·
  [ADR 0264](0264-host-mediated-actions-follow-the-browsed-folder.md) ·
  [ADR 0328](0328-browser-arbitrary-local-files.md) · E2E-153

## Context

The bundled File Manager can open files with the OS application or reveal them,
but HTML previews need the work-panel Browser, whose public `pi.browser.*` API is
gated by the high-risk `browser.cdp` permission that also exposes page inspection
and control.

## Decision

Add the additive `pi.fs.openInBrowser(pathFromRoot)` API and panel bridge channel
`fs.openInBrowser`, covered by the existing `fs.read` permission. The path is
resolved with the same real-path, protected-path, credential deny-list,
declared-scope, and project-group root checks as other host-mediated file actions,
accepting only existing regular `.html`, `.htm`, or `.xhtml` files and auditing
successes and refusals. After validation Electron Main sends a Browser-open event
and the renderer creates a Browser resource tab for the active local session,
failing with `UNAVAILABLE` when the bundled Browser plugin is disabled. The action
grants no `browser.cdp`, does not broaden `BrowserPreview`, and leaves the
Browser's local file navigation policy (ADR 0328) and every protocol and persisted
format unchanged.

## Consequences

- A File Manager user previews an authorized HTML file without leaving the work
  panel or granting Browser control.
- Plugins cannot use the API for directories, non-HTML files, credentials,
  protected data, or paths outside their declared read scope.

## Alternatives considered

- Grant `browser.cdp` to the File Manager: rejected; it also allows page
  inspection and browser actions.
- Reuse `BrowserPreview` or `shell.openExternal(file:)`: rejected; both are
  scoped differently and external opening excludes local file URLs.
