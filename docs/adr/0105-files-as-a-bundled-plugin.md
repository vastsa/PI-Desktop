# ADR 0105: Ship Files as a bundled plugin; keep Review in the host

- Status: Accepted (amended 2026-08-19; terminal clause superseded by ADR 0108)
- Date: 2026-08-19
- Deciders: PI-Desktop core
- Related: [ADR 0019](0019-work-panel-subsystems.md) ·
  [ADR 0104](0104-plugin-contributed-work-panel-views.md) ·
  [ADR 0108](0108-remove-built-in-interactive-terminal.md) ·
  [07-plugins/13-plugin-permissions-matrix](../spec/07-plugins/13-plugin-permissions-matrix.md)

## Context

The work panel has a public extension point for plugin-contributed views. The
bundled Files browser should exercise that public path rather than remaining a
special host-only view. Review remains message-owned by ADR 0043 and therefore
has a different ownership boundary.

## Decision

1. `pi.files` is a first-party plugin shipped from
   `apps/desktop/resources/plugins/` and contributes its view through
   `contributes.views` just like a third-party plugin.
2. The bundled plugin is enabled by default, cannot be uninstalled, and can be
   disabled by the user. Its filesystem access uses the public permission-gated
   read APIs.
3. Only the Files *tool* migrates. Transcript-owned `file:<path>` resources and
   Review artifacts remain host-rendered and message/session scoped.
4. Browser chrome and agent CDP ship as bundled plugin `pi.browser` (ADR 0170).
   The guest `WebContentsView` and debugger remain host window machinery,
   reached only through the public `pi.browser.*` API.
5. The former proposal to keep an interactive terminal in the host is
   superseded by ADR 0108. There is no plugin PTY API and no private bundled
   plugin channel.

## Consequences

- The shipped plugin is a real consumer of the public contributed-view and
  filesystem APIs; gaps in those APIs are caught by a first-party feature.
- The launcher lists Browser and active plugin views. Review and file resources
  are opened by conversation artifacts.
- The plugin trust boundary stays unchanged: no plugin permission can spawn an
  interactive shell.

## Alternatives considered

### Keep Files, Review, and the interactive terminal as host tools

Rejected for Files: it would leave the public plugin extension point untested.
Review remains host-owned because its evidence belongs to transcript messages.
The interactive terminal is removed rather than migrated; ADR 0108 records why.

### Give the bundled plugin private host capabilities

Rejected: a private channel would not test the public plugin API and would
recreate the host/plugin trust split this ADR is intended to reduce.
