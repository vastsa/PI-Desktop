# ADR 0016: Organize the sidebar around retained multi-project tabs

- Status: Accepted
- Date: 2026-07-26

## Context

D088 replaced the mixed Recents list with one current-project group plus
path-less Temporary sessions. That made the workspace boundary visible, but it
also forced every project switch to replace the only project group and removed
basic organization controls.

## Decision

### Retained project tabs

- The renderer retains an ordered set of normalized project paths.
- Opening a project adds its path without closing other tabs.
- Closing a tab removes only its retained sidebar entry.

### Renderer-owned organization metadata

- Project metadata is keyed by normalized full path and contains `pinned`,
  `archived`, `collapsed`, and optional manual `order`.
- Conversation metadata is keyed by durable session id and contains `pinned`,
  `archived`, and optional manual `order`.
- User-facing sidebar ordering supports `recent`, `created`, `oldest`, and
  `name`.
- Archive is non-destructive.
- The presentation record is best-effort renderer local storage.

### Session workspace isolation

- The project associated with a session is the authority for that session's tool
  root.
- Selecting another project or conversation never aborts a running turn.
- Temporary sessions have no project root.

This supersedes D088's one-current-project and no-multi-project-tree
limitations, and restores scoped project/conversation row actions superseded
with D068. D088's exact-path grouping, scoped draft reuse, and Temporary session
boundary remain in force.

## Consequences

- The sidebar can show several project groups in one independently scrollable
  region while the main pane still shows one destination/transcript.
- Project/session pin, archive, collapse, sort, and open paths survive app
  restart when renderer preferences are available.
- Activating a missing or inaccessible retained path reports the existing
  workspace error without silently deleting the tab or its sessions.
- Host tool execution must load the session before resolving its workspace.
- The Projects index remains the durable project directory and the recovery path
  for closed or archived sidebar tabs.

## Alternatives

### Keep exactly one project group

Rejected because it discards the working set on every project switch and makes
parallel session work cumbersome.

### Store archive and pin flags in the host schema

Rejected for this iteration because the flags affect only local presentation.

### Add one host workspace per open tab

Rejected because only tool execution needs a workspace root, and the durable
session already identifies it.

### Open each project in a separate native window

Rejected because it multiplies window/process state and does not solve
conversation organization in the primary workbench.

## References

- `docs/spec/03-runtime/03-tools-and-permissions.md`
- `docs/spec/03-runtime/04-data-storage.md`
- `docs/spec/03-runtime/06-host-rpc-protocol.md`
- `docs/spec/04-ux/01-ui-ia.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/04-ux/09-interaction-patterns.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `docs/spec/08-meta/decisions-log.md` (D093)
