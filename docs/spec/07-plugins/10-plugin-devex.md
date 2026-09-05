# 10. Plugin Developer Experience

## 1. Goals

Let a developer create and load a local plugin within 10 minutes.

The task-oriented [zero-to-one plugin development guide](../../plugin-development.md)
covers the complete author journey. This specification freezes the developer
surfaces and their acceptance criteria.

## 2. Developer path

```text
Create from template            (the folder opens as the project)
 → edit manifest / main / panel   (hot reload keeps it live)
 → verify in the command palette
 → check
 → pack piplug
```

The first step has three entry points, all calling the same
`@pi-desktop/plugin-devkit` implementation:

- **Plugins page** — the overflow menu's "New plugin from template", or the
  button on the empty state. Picks a template, asks for a folder, writes the
  files, loads the result as a development plugin, and then opens that folder as
  the active project so the sources are already in the workspace the agent and
  the file panel read. If the folder cannot be opened as a project the plugin
  still stays loaded, and the toast says only that it was created and loaded.
- **Agent** — `PluginScaffold`, in a conversation ("write me a plugin that …").
  It writes inside the current workspace, which is already open.
- **CLI** — `pnpm pi-plugin init <template> <dir>`.

## 3. Template types

Official templates, all four available:

1. `panel-basic`: panel + command
2. `agent-tool-basic`: register a tool
3. `skill-pack`: skills only
4. `full-demo`: panel + command + tool + skill + settings

Every template scaffolds a manifest with `schemaVersion: 1`, a `main.js`, a
README, and only the permissions the template actually uses. Scaffolding refuses
to write into a non-empty directory.

Panel templates include the current `pi-plugin-chrome` v2 marker and the
neutral PI-Desktop surface tokens. Their body uses
`var(--pi-plugin-titlebar-height, 0px)` so the same entry works in a detached
window and a docked work-panel view without adding a second top spacer.

Current repo example:
- `examples/plugins/hello`

## 4. SDK and devkit

`@pi-desktop/plugin-sdk` is imported by plugin code itself and stays
dependency-free and Node-free. It provides:
- manifest types
- permission enums
- API types (`PiPluginHostApi`)
- manifest validation function
- test helper (mock host)

The SDK's clipboard surface includes `pi.clipboard.getHistory()`, which
returns bounded, newest-first text and image entries through the existing
`clipboard.read` permission. Plugin authors should use it for clipboard-history
features instead of polling `readText()` and maintaining a second store.

`@pi-desktop/plugin-devkit` is tooling, not runtime, and may use Node. It owns
`scaffold` / `check` / `pack` and the `pi-plugin` CLI. All three developer
surfaces (CLI, agent tools, plugins page) call it, so a rule enforced once holds
everywhere.

## 5. Local development commands

The CLI is currently delivered as a private workspace package. From a checkout
of this repository, install dependencies and build the devkit plus its
dependencies once:

```bash
# repository setup
pnpm install
pnpm --filter @pi-desktop/plugin-devkit... build

# create from a template
pnpm pi-plugin init full-demo /tmp/my-plugin

# validate manifest and package contents
pnpm pi-plugin check .

# pack
pnpm pi-plugin pack .

# outputs dist/demo.hello-0.1.0.piplug

# pack and pin the version to the commit that produced it
pnpm pi-plugin publish .

# also writes dist/demo.hello-0.1.0.submission.json
```

`publish` is for distributing through the plugin center. It packs, then records
the canonical repository URL, the tag or commit ref, the resolved commit, and
the plugin subdirectory alongside the package checksum, so the artifact and the
source it claims to come from describe one moment. It refuses a dirty worktree
and a git remote carrying credentials, and warns when no tag points at HEAD.
The center re-resolves everything itself; a submission is a claim to be checked.
See [15-plugin-center.md](15-plugin-center.md).

`check` reproduces every rule the installer enforces, so `check` passing implies
install will pass. It reports errors — a missing or unparseable `manifest.json`,
missing `main` / `ui.panel` / skill files, a skill path escaping the plugin
directory, an unknown permission, a symlink, more than 2000 files, more than
50 MB — and warnings, which do not block: high-risk permissions, permissions
declared but never used by the code, `contributes.skills` without
`agent.prompt.inject` (the skills would be inert), and an empty `contributes`.

`pack` writes `dist/<id>-<version>.piplug`, skipping `.git` and `node_modules`
exactly as the installer's copy does, and prints the sha256. It runs `check`
first and refuses to pack a plugin with errors. **Entries are stored
uncompressed (method 0)**: the installer accepts nothing else, so a `.piplug`
must never be built with `zip` or another shell tool.

## 6. Agent tools

Three tools are served from Electron main (host-core never sees them), each
resolving its `directory` argument against the session's workspace root and
refusing to escape it:

| Tool | Modes | Effect |
|---|---|---|
| `PluginCheck` | all | Validates a plugin directory; read-only |
| `PluginScaffold` | agent | Writes a template, then loads it as a development plugin |
| `PluginPack` | agent | Validates, then writes `dist/<id>-<version>.piplug` |

A built-in skill, `apps/desktop/resources/skills/plugin-development.md`,
documents the manifest schema, the permission tiers, the host API surface, and
this loop. It activates only when the session workspace looks like plugin
development — a plugin `manifest.json` at the workspace root, or a loaded
development plugin inside it — so ordinary sessions pay only for the three tool
descriptions. Scaffolding writes a manifest, which turns the full skill on from
the next prompt; creating from a template on the plugins page also opens the new
folder as the project, so the workspace test passes right away.

A second built-in skill, `apps/desktop/resources/skills/a2a-cross-conversation.md`
(`pi-desktop/a2a-cross-conversation`), is catalogued in every session. It
teaches the parent `A2A` tool (ADR 0164): discover other live conversations
before claiming isolation, address by peer name not session UUID, and never
send to subagents.

## 7. Hot reload

A plugin loaded from a folder is watched from then on, including across
restarts: the folder is picked once, not once per edit.

- Any change under the plugin directory reloads it, debounced 300 ms, so one
  save burst is one reload. `node_modules`, `.git`, `dist`, `target` and editor
  scratch files are ignored — a plugin writing into its own `dist/` must not
  reload itself forever.
- A reload unloads the previous process and runs the plugin again from disk, so
  a manifest, `main`, or skill change all take effect the same way. Panels are
  re-created from the reloaded contribution.
- **A reload can never widen permissions.** The reload reads the manifest first
  and compares it against the set approved when the folder was picked; anything
  new stops the reload with `PERMISSION_DENIED` and a message to load the plugin
  again so the grant can be reviewed. Removed permissions do take effect
  immediately — grants follow the manifest downwards, never upwards.
- The Plugins page offers Reload for `source: "dev"` rows inside the row's More
  actions menu. After a permission-gated hot reload, choosing it explicitly
  reloads the registered folder with the current manifest and refreshes the
  permission ceiling used by later file-watch reloads. The action does not
  require picking the folder again.
- A failed reload (syntax error, invalid manifest) leaves the plugin unloaded
  but still watched, so the save that fixes it recovers the plugin. The failure
  is reported as a toast plus a plugin-changed event; the registry row does not
  currently move to `load_error`, because host-core has no RPC for a
  runtime-side load failure.
- Watchers are released on unload, disable, uninstall and quit, and are capped
  at 16 plugins; past the cap the app logs and edits need a manual reload.

## 8. Debugging

Implemented today:

- Load and hot-reload failures appear as toasts; persisted load failures also
  appear on the plugin row.
- Open **Settings → Info → Logs** and filter records by `pluginId` to inspect
  lifecycle, host API, tool, service, and bus activity.
- The Plugins page shows declared capabilities, permissions, and resident
  service state. Registered commands can be verified in global search.

Later:

- Dedicated per-plugin log panel with stack-copy affordance
- Dedicated DevTools for the panel
- Mock tool invoker

## 9. Documentation checklist (developer site / repo docs)

- Quick start
- manifest fields
- Permission reference
- API manual
- Publishing manual (pack/sign)
- Security best practices

## 10. Quality gate (recommended before publishing)

- `pi-plugin check` reports no errors
- No calls to undeclared permissions
- Has a README
- Has a version changelog
- If it includes a tool: provide parameter examples

## 11. Acceptance

1. A new plugin can be created from a template, from the plugins page, the agent
   or the CLI
2. Development load succeeds
3. An edit reloads the plugin without re-picking its folder, and a broken edit
   recovers on the next save
4. `check` passes and the `pack` artifact installs
5. A declared skill reaches the model when `agent.prompt.inject` is granted, and
   stops reaching it when the permission is revoked
