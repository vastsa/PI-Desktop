# ADR 0105: Ship Files as a bundled plugin; keep Review in the host

- Status: Superseded by [ADR 0241](0241-vendored-updatable-file-view-plugin.md)
- Date: 2026-08-19
- Related: [ADR 0019](0019-work-panel-subsystems.md) ·
  [ADR 0104](0104-plugin-contributed-work-panel-views.md) ·
  [ADR 0108](0108-remove-built-in-interactive-terminal.md) ·
  [ADR 0170](0170-work-panel-browser-as-bundled-plugin.md) · D451

## Context

The work panel exposes a public extension point for contributed views, so the
bundled Files browser had to exercise that public path instead of staying a
host-only view. Review stays transcript-owned by ADR 0043 and therefore has a
different boundary.

## Decision

`pi.files` becomes a bundled first-party plugin contributing its view through
`contributes.views`, enabled by default, uninstallable, disableable by the user,
and reading the filesystem only through public permission-gated APIs. Only the
Files tool migrates; transcript-owned `file:<path>` resources stay, and Review
opens only on explicit user action (D451). Browser chrome ships as bundled plugin
`pi.browser` over the same public API.

## Consequences

Superseded by ADR 0241, which replaced the bundled plugin with the vendored,
updatable file view plugin `pi.file-manager`; the reasoning above is what the
replacement inherits. The terminal clause was already superseded by ADR 0108.
