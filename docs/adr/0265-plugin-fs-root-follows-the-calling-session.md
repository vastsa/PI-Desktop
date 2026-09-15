# ADR 0265: Plugin fs Roots Follow the Calling Session

- **Status**: Accepted
- **Date**: 2026-09-16
- **Related**: [ADR 0016](0016-sidebar-organization-and-multi-project-tabs.md) ·
  [ADR 0249](0249-chatgpt-style-logical-project-groups.md) ·
  [ADR 0263](0263-project-folder-roots-for-plugin-views.md) ·
  [ADR 0264](0264-host-mediated-actions-follow-the-browsed-folder.md) ·
  [07-plugins/03-plugin-api](../spec/07-plugins/03-plugin-api.md) ·
  [07-plugins/13-plugin-permissions-matrix](../spec/07-plugins/13-plugin-permissions-matrix.md)

## Context

D093 gives the sidebar several retained project tabs while the shell keeps one
selected host workspace, and it fixes the rule this ADR extends: **tool execution
resolves its root from the durable session project**, so a background session
keeps its own root when another tab becomes active. ADR 0016 and ADR 0249 carry
that separation into the project model, and ADR 0263 / ADR 0264 make the folder
a view browses plugin-local and per project.

That rule never reached a plugin. Every `pi.fs.*` request resolved its root as

```ts
rule.root === "userSelected" ? loaded.userRoot : this.services.getWorkspacePath()
```

and `getWorkspacePath()` is the single window-global visible workspace. Two
sessions on two projects therefore measured every plugin fs call against
whichever project the window happened to show: a plugin agent tool invoked from
session B (project B) read project A's root as soon as the user switched tabs, and
that same tool failed `NOT_FOUND` ("No workspace is open") for every session at
once when no workspace was visible at all (a temporary chat). The four path-safety
gates -- permission, realpath containment, the deny-list, and the declared
scope/consent -- were correct; only the directory they measured against was wrong.

## Decision

1. **The `workspace` root resolves the project of the tool session that invoked
   the call.** A new private helper `fsRoot(loaded, rule)` in `plugin-runtime.ts`
   reads the in-flight tool's `sessionId`, asks the additive host service
   `getWorkspacePathForSession(sessionId)`, and uses the project it answers as the
   root. The visible workspace is a fallback only, not the primary answer.
2. **The session is the dimension the root follows; the fallback is the visible
   workspace.** A panel-bridge call has no tool session, and a session the host
   does not track -- a runtime that has not launched yet -- resolves the visible
   workspace exactly as before.
3. **A `userSelected` mode is unchanged.** It keeps the directory the user picked
   through `requestDirectory()`, with the same memory-only lifetime.
4. **`plugin-services.ts` wires the service from the `sessionProjects` map it
   already keeps** for D093. No new source of truth is introduced, and the plugin
   runtime caches nothing: each call reads the host's current answer.
5. **Not one path-safety gate changes.** Permission, realpath containment, the
   deny-list, and the declared scope with runtime consent still run, in the same
   order, over the resolved root. Only *which* directory the `workspace` root
   names changes.
6. **A session root also resolves when no workspace is visible.** A temporary
   chat has no visible workspace, so its plugin tools used to fail all at once;
   with a session project they keep working per session. A panel call in that
   state still fails closed, because it has nothing else to resolve.

## Consequences

- Two sessions on two projects no longer cross-talk: a plugin agent tool reads and
  writes under the project of the session that invoked it, whatever tab is active.
- Panel-bridge fs calls keep their old meaning: they follow the visible workspace.
- A plugin that only ever ran one session on one project sees no change at all.
- `NOT_FOUND` for a `workspace` root is now narrower and more precise: neither the
  invoking session's project nor a visible workspace resolved.
- The plugin runtime reads session metadata the host already owns, so the change
  adds no stored state, no migration, and no new plugin permission.

## Alternatives considered

### Keep the visible workspace and let the tool pass a project id

Rejected: the host already knows the invoking session, so the plugin would have to
learn and forward a project identifier it does not own, and a plugin-supplied root
would be a grant its manifest never declared.

### Resolve the session's project inside the plugin process

Rejected: the session-to-project map is host-owned session metadata (D093), and
copying it into a sandboxed plugin process would move it outside the host
authority that keeps it current.

### Make the visible workspace follow the active session

Rejected: the visible workspace is what the user is looking at, and ADR 0016 with
D093 deliberately keep several retained tabs over one selected host workspace.
Changing what the user sees in order to fix a plugin lookup inverts the causality.

### Fall back to the last visible workspace for a session the host does not track

Rejected as no-op: an untracked session plus no visible workspace is exactly the
temporary-chat case the session root exists to keep working, so the fallback stays
"the visible workspace, when there is one".
