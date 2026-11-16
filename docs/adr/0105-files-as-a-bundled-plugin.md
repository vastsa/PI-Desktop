# ADR 0105: Ship Files as a bundled plugin; keep Review in the host

- Status: Superseded by [ADR 0241](0241-vendored-updatable-file-view-plugin.md)
- Date: 2026-08-19
- Deciders: PI-Desktop core
- Related: [ADR 0019](0019-work-panel-subsystems.md) ·
  [ADR 0104](0104-plugin-contributed-work-panel-views.md) ·
  [ADR 0108](0108-remove-built-in-interactive-terminal.md) ·
  [07-plugins/13-plugin-permissions-matrix](../spec/07-plugins/13-plugin-permissions-matrix.md)

> Superseded by ADR 0241. Files is no longer a bundled first-party plugin: the
> work panel's file view is now a vendored, updatable third-party plugin
> (`pi.file-manager`). The reasoning below still holds and is what the
> replacement inherits — the view is an ordinary plugin on the public
> `contributes.views` channel, and Review stays with the transcript. The
> terminal clause was already superseded by ADR 0108.

## Context

The work panel has a public extension point for plugin-contributed views.

## Decision

1. `pi.files` is a first-party plugin shipped from
   `apps/desktop/resources/plugins/` and contributes its view through
   `contributes.views` just like a third-party plugin.

## Consequences

Superseded (Superseded by [ADR 0241](0241-vendored-updatable-file-view-plugin.md)). The full record is in git history.
