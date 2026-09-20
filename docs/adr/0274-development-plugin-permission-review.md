# ADR 0274: A development plugin is reviewed before it is loaded

- Status: Accepted for implementation
- Date: 2026-09-17
- Deciders: PI-Desktop core
- Related: [ADR 0005](0005-user-installable-plugin-system.md) ·
  [ADR 0110](0110-plugin-panel-chrome-spacing-contract.md) ·
  [07-plugins/12](../spec/07-plugins/12-plugin-ipc-and-host-services.md) ·
  [07-plugins/13](../spec/07-plugins/13-plugin-permissions-matrix.md)

## Context

A plugin's permissions are approved by the user at load time, and the approval is
the ceiling: hot reload never widens it (`plugin-runtime.ts`, `reloadDevPlugin`).
Two holes sat around that rule.

First, loading a development plugin folder was never a review. The folder picker
called `plugins.loadDev` and `PluginRuntime.loadFromPath` with the permissions the
manifest declared, so the declaration *was* the grant. The permission-review modal
that guards the marketplace install path (`PluginDialogs.tsx`) was unreachable for
development plugins, which is where plugin authors actually work.

Second, the manual **Reload** used the registry row's permission list as the
approval and passed it through `loadFromPath`'s `granted ∩ declared` filter.
A manifest edit that added a permission therefore reloaded *silently* with that
permission dropped, and `watchDevPlugin` then recorded the intersection as the new
ceiling. The plugin came back partly broken, the reason was invisible, and every
following save hit `PERMISSION_DENIED: manifest now requests ui.microphone; load
the plugin again to review` — advice that pointed at a picker which reviewed
nothing.

## Decision

1. Choosing a development plugin folder is a request, not consent.
   `plugin/loadDev` returns `{ canceled: false, review }` where `review` is the
   validated declaration (`PluginPermissionReview`): id, name, version, every
   declared permission, and what is beyond the current approval. Nothing is
   registered and nothing is loaded at this point.
2. `plugin/loadDevConfirm` commits the answer. It registers the folder
   (`plugins.loadDev`, which rewrites the registry row from the manifest), loads
   it with the accepted permissions only, and arms the watcher whose ceiling is
   that same accepted set.
3. `plugin/reload` compares the manifest against the **recorded approval**
   (`PluginRuntime.devApproval`), never against the registry row. Permission
   names and file scope are both compared: a new glob is asking for more, exactly
   like a new permission. When nothing was added it reloads immediately — the
   ordinary edit/save/reload loop must not become a dialog.
4. When something was added, `plugin/reload` returns a review instead of
   loading. The plugin keeps running under its current approval until the user
   answers through `plugin/reloadConfirm`, which reloads under the accepted set
   and makes that set the new ceiling.
5. The scaffold flow (`plugin/createFromTemplate`) writes files and then returns
   the same review. Registering a scaffolded plugin goes through the reviewed
   load like any picked folder.
6. Paths and identities in a confirmation come from the host: the renderer sends
   an id (or the path it just picked) and the accepted permission list, never a
   path of its own choosing for an already-registered plugin.
7. The `PERMISSION_DENIED` text of the hot-reload refusal now names an action
   that exists: *reload it from the Plugins page to review*.
8. Both reviews render through one `PermissionGroups` component, so the install
   review and the development review cannot drift apart about what is risky.

## Consequences

- A plugin author sees the same permission review a marketplace install shows,
  at the moment they choose a folder, and again whenever an edit asks for more.
  The answer, not the manifest, is what the runtime enforces.
- A manifest edit that widens silently can no longer produce a half-working
  plugin: it is either applied with the user's answer or not applied at all.
- Nothing is granted against an unreadable manifest: the declaration is
  validated before it becomes a review, and a failed read refuses the flow.
- The registry row is rewritten on every reviewed load, so it always states the
  current declaration rather than the one from first load; the *approval* is the
  watcher ceiling, which is the record that matters for reload.
- Widening still requires a user decision even in development, so the security
  property the hot-reload guard exists for survives the fix.
