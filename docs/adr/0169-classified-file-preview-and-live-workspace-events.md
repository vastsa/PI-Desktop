# ADR 0169: Classified file preview and live workspace events for plugin views

- Status: Accepted
- Date: 2026-09-06
- Related: [ADR 0104](0104-plugin-contributed-work-panel-views.md) · [ADR 0105](0105-files-as-a-bundled-plugin.md) · [ADR 0109](0109-open-files-with-the-os-associated-application.md) · [ADR 0111](0111-reveal-files-in-file-manager.md) · D332 · E2E-153

## Context

The bundled `pi.files` view is a public plugin consumer (ADR 0105). After it
replaced the host Files tool, `fs.readText` could not classify images, binaries, or
oversized files, **Open with default app** had left the UI with reveal (ADR 0111),
panel events reached only detached `ui.panel` windows, and the view polled
`workspace.get` because `workspace:changed` did not exist.

## Decision

1. Add `pi.fs.readPreview(pathFromRoot)` and the panel channel `fs.readPreview`,
   gated by `fs.read` and the declared-scope checks, classifying one existing
   regular file as `text`, `image`, `binary`, or `tooLarge` under the host Files tab
   size caps; images return a data URL, binary and oversized files return no
   payload bytes, and directories are rejected.
2. Broadcast every plugin panel event to detached windows and live docked views
   over the same `pi-plugin-panel-event:<event>` preload channel.
3. Deliver `workspace:changed` to panels and plugin processes whenever the cached
   workspace path changes, with the `workspace.get()` payload `{ path, name } |
   null`.
4. Restore **Open with default app**, add search through `fs.glob`, copy the
   root-relative path from a user gesture, and preview images through
   `fs.readPreview`, all on public APIs.

## Consequences

- Plugins can preview images and oversized files without a second read API.
- A docked view follows theme, locale, and project switches live.
- The Files plugin stays a public-API consumer; transcript `file:<path>` tabs stay
  host-owned.

## Alternatives

- Detect images in the plugin from `fs.readText`: rejected, UTF-8 decoding of PNG
  or JPEG is lossy and cannot produce a data URL.
- A private Files IPC channel: rejected, it recreates the host/plugin exception
  ADR 0105 removed.
