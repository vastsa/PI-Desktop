# ADR: Native context panel over the trusted extension bridge

- Status: Accepted for implementation
- Date: 2026-09-25
- Related: ADR 0214, ADR 0215, `07-plugins/16-trusted-extensions.md`

## Context

Pi-Context exposes category snapshots and context-pack commands. The terminal-only
`ui.custom` and `ui.setWidget` methods are deliberately inert in PI-Desktop.
The desktop already owns the work panel and a session-scoped trusted-extension
status transport. The old standalone `~/.pi/agent/extensions` discovery is not
part of the launch path; ADR 0215 makes active plugin contributions authoritative.

## Decision

1. An **enabled plugin contribution** may load Pi-Context into the Agent
   sidecar. A junction in the CLI extensions directory alone never enables it.
2. The sidecar projects only the current model-context messages as a read-only
   `sessionManager.getBranch()` view; it does not expose SQLite or change
   persisted session semantics.
3. Only `pi.events.emit("context:snapshot", snapshot)` crosses the existing
   trusted-extension status transport, with a 256,000-character JSON limit.
   The renderer validates the shape, binds it to its originating session, and
   does not render the serialized event as a human-readable status line.
4. The native Context work-panel tab offers usage categories and invokes the
   existing export/import/handoff extension commands. Until the next snapshot,
   it displays a separate last-request usage estimate rather than inventing
   category totals. Plugin permissions and project activation remain unchanged.

## Consequences

This adds a bounded sidecar-to-renderer data use of the existing status channel;
no new Electron IPC channel or Rust persistence is introduced. The extension
must be imported/enabled through the existing plugin workflow before its
categories or pack commands become available. A future generic extension event
bus needs a separate contract and decision.
