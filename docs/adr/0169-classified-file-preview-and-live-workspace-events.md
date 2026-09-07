# ADR 0169: Classified file preview and live workspace events for plugin views

- Status: Accepted
- Date: 2026-09-06
- Deciders: PI-Desktop core
- Related: [ADR 0104](0104-plugin-contributed-work-panel-views.md) ·
  [ADR 0105](0105-files-as-a-bundled-plugin.md) ·
  [ADR 0109](0109-open-files-with-the-os-associated-application.md) ·
  [ADR 0111](0111-reveal-files-in-file-manager.md) · D332 · E2E-153

## Context

The bundled `pi.files` view is a public plugin consumer (ADR 0105). After it
replaced the host Files tool, several first-party browsing behaviors were
missing or broken:

1. `fs.readText` cannot classify images, binary files, or oversized files, so
   the plugin reported images as unavailable and could load large binaries as
   UTF-8.
2. `fs.openDefault` existed (ADR 0109) but left the Files UI when reveal
   replaced the header action (ADR 0111).
3. Panel events such as `appearance:changed` were broadcast only to detached
   `ui.panel` windows. Docked work-panel views never received them.
4. `workspace:changed` was specified as planned. The Files view polled
   `workspace.get` every two seconds instead.

## Decision

1. Add `pi.fs.readPreview(pathFromRoot)` and the panel channel `fs.readPreview`,
   gated by the existing `fs.read` permission and the complete declared-scope
   checks. The host classifies one existing regular file as `text`, `image`,
   `binary`, or `tooLarge`, using the same size caps as the host Files tab
   (512 KiB text, 5 MiB image). Images return a data URL; binary and oversized
   files return no payload bytes. Directories are rejected.
2. Broadcast every plugin panel event to both detached panel windows and live
   docked views over the same `pi-plugin-panel-event:<event>` preload channel.
3. Deliver `workspace:changed` to panels and plugin processes whenever the
   cached workspace path changes. The payload matches `workspace.get()`:
   `{ path, name } | null`.
4. Restore **Open with default app** in the bundled Files viewer, add search
   through `fs.glob`, copy the root-relative path from a user gesture, and
   preview images through `fs.readPreview`. No private bundled-plugin channel
   is introduced.

## Consequences

- Third-party plugins can preview images and oversized files without inventing
  a second read API.
- A docked view follows theme, locale, and project switches live.
- The Files plugin remains a public-API consumer; transcript `file:<path>`
  tabs stay host-owned.

## Alternatives considered

### Reuse `fs.readText` and detect images in the plugin

Rejected: UTF-8 decoding of PNG/JPEG is lossy, has no size cap, and cannot
produce a data URL without a binary channel.

### A private Files IPC channel

Rejected: that would recreate the host/plugin exception ADR 0105 removed.
