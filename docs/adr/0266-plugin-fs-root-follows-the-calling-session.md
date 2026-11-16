# ADR 0266: Plugin fs Roots Follow the Calling Session

- Status: Accepted
- Date: 2026-09-16
- Related: [ADR 0016](0016-sidebar-organization-and-multi-project-tabs.md) ·
  [ADR 0249](0249-chatgpt-style-logical-project-groups.md) ·
  [ADR 0263](0263-project-folder-roots-for-plugin-views.md) ·
  [ADR 0264](0264-host-mediated-actions-follow-the-browsed-folder.md) ·
  [07-plugins/03-plugin-api](../spec/07-plugins/03-plugin-api.md)

## Context

D093 lets the sidebar retain several project tabs over one selected host workspace and
fixes the rule this record extends: tool execution resolves its root from the durable
session project. That rule never reached a plugin, because every `pi.fs.*` request
resolved its root from the window-global visible workspace, so two sessions on two
projects measured their calls against whichever project the window showed, and a
temporary chat with no visible workspace failed `NOT_FOUND` for every session at once.

## Decision

1. **The `workspace` root resolves the project of the tool session that invoked the
   call.** A private `fsRoot(loaded, rule)` helper reads the in-flight tool's
   `sessionId`, asks the additive host service `getWorkspacePathForSession`, and uses
   the project it answers.
2. **The session is the dimension the root follows; the fallback is the visible
   workspace.** A panel-bridge call has no tool session, and an untracked session
   resolves the visible workspace as before.
3. **A `userSelected` mode is unchanged**, keeping the directory the user picked
   through `requestDirectory()` with the same memory-only lifetime.
4. **`plugin-services.ts` wires the service from the `sessionProjects` map it already
   keeps** for D093, so no new source of truth appears and nothing is cached.
5. **Not one path-safety gate changes.** Permission, realpath containment, the
   deny-list, and declared scope with runtime consent still run in the same order over
   the resolved root.
6. **A session root also resolves when no workspace is visible**, so temporary chats
   keep working, while a panel call in that state still fails closed.

### Workspace metadata consistency amendment

Discovery and registered-folder actions use the same host-owned session mapping
through one internal resolver, so `workspace.get` and registered-folder metadata
cannot point at the visible project while file calls reach the session's. Panel and
untracked-session fallbacks are unchanged, and plugins that enqueue callbacks must
preserve the caller's async context per job.

## Consequences

- Two sessions on two projects no longer cross-talk, whatever tab is active.
- Panel-bridge calls keep following the visible workspace.
- `NOT_FOUND` now means neither the invoking session's project nor a visible workspace
  resolved, and no stored state, migration, or plugin permission is added.

## Alternatives

- Keep the visible workspace and let the tool pass a project id — rejected: a
  plugin-supplied root would be an undeclared grant.
- Resolve the session's project inside the plugin process — rejected: the map is
  host-owned metadata that must stay current.
