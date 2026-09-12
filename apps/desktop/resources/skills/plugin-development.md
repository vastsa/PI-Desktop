---
name: PI-Desktop plugin development
description: the user is writing, checking, packaging or debugging a PI-Desktop plugin
---

You are working inside a PI-Desktop plugin. Use the `PluginScaffold`, `PluginCheck` and
`PluginPack` tools instead of hand-rolling files or shell commands — they enforce the same
rules the installer does, so anything they accept will install.

## Development loop

1. `PluginScaffold` — create a plugin from a template. It writes the directory and loads the
   plugin immediately, so it is live before you edit anything.
2. Edit the source. A plugin loaded from a directory hot-reloads on save: no re-picking the
   folder, no restart. Widening `permissions` — or widening a file scope in `manifest.fs` —
   is the one exception: that needs an explicit re-load, because hot reload must never grant
   reach the user did not approve.
3. `PluginCheck` — validate the plugin. Fix every error; treat warnings as review notes.
4. `PluginPack` — produce `dist/<id>-<version>.piplug`, installable from the plugins page.

Templates: `panel-basic` (a webview panel), `agent-tool-basic` (a tool the agent can call),
`skill-pack` (instruction documents only), `full-demo` (all three plus a setting).

## manifest.json

```json
{
  "schemaVersion": 1,
  "id": "local.my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "main": "main.js",
  "permissions": ["ui.panel"],
  "ui": { "panel": "renderer/index.html" },
  "contributes": {
    "commands": [{ "id": "my-plugin.hello", "title": "Say hello" }],
    "agentTools": [{ "name": "echo_text", "description": "Echo the input" }],
    "skills": ["skills/my-plugin.md"],
    "settings": [{ "key": "greeting", "type": "string", "default": "Hello" }]
  }
}
```

`schemaVersion`, `id`, `name`, `version` and `main` are required. `id` must match
`[a-zA-Z0-9][a-zA-Z0-9._-]*`; prefix personal plugins with `local.`. Every path is relative to
the plugin directory and may not escape it.

## Entry point

`main.js` is directly executable JavaScript, evaluated in a dedicated process with no access
to the host's environment variables. The host injects a global `pi` object. Export lifecycle
hooks without arguments:

```js
async function onLoad() {
  await pi.commands.register({
    id: "my-plugin.hello",
    title: "Say hello",
    run: async () => {
      await pi.ui.showToast("Hello from my plugin");
    },
  });
}

async function onUnload() {
  await pi.commands.unregister("my-plugin.hello");
}

module.exports = { onLoad, onUnload };
```

`onLoad` must finish within 15s, other hooks within 5s, agent tools within 110s. An
uncaught error during load rolls the whole load back and leaves the plugin in `load_error`.
Only `onLoad` and `onUnload` are fired today.

## Panel UI

PI-Desktop hosts every panel in a frameless window. The host reserves exactly a
transparent 46px drag band and renders only a minimal fixed capsule in the
top-right with minimize, maximize/restore, and close controls. The panel title,
toolbar, background, and every other visible surface belong to the plugin.
Normal-flow content is offset automatically, so do not add another 46px top
padding. The drag band is not clickable outside the capsule; development
panels show a reminder for this constraint.

For `position: fixed` or `position: sticky` top UI, use the host variable rather
than `top: 0`:

```css
.panel-toolbar {
  position: sticky;
  top: var(--pi-plugin-titlebar-height, 46px);
  -webkit-app-region: drag;
}

.panel-toolbar button {
  -webkit-app-region: no-drag;
}
```

Account for the same 46px value in viewport-height calculations:
`height: calc(100dvh - var(--pi-plugin-titlebar-height, 46px))`.

The panel receives `window.pluginBridge`, not `pi`. Use the fixed bridge channels such as
`ui.showToast`, `ui.closePanel`, `ui.getNotificationPermission`,
`ui.requestNotificationPermission`, `ui.showNativeNotification`, `plugin.getSettings`,
`workspace.get`, `fs.readText`, `fs.stat`, `fs.readRange`, `fs.writeText`, `fs.glob`, `clipboard.readText`,
`clipboard.getHistory`, `clipboard.writeText`, `shell.openExternal`, and `net.fetch`.
Arbitrary Electron IPC and
general custom panel RPC are not exposed.

## Permissions

Every permission is declared in the manifest and granted at install time; an undeclared call
fails at runtime. Ask for the least you need — the plugins page shows the risk tier to the
user.

- High risk: `net.fetch`, `fs.write`, `fs.delete`, `agent.prompt.inject`,
  `agent.tool.register`, `agent.complete`, `session.read`, `mcp.server.local`,
  `mcp.server.remote`
- Medium: `fs.read`, `clipboard.read`, `clipboard.write`, `shell.openExternal`,
  `background.service`, `bus.publish`, `bus.subscribe`, `models.list`
- Low: `ui.panel`, `ui.theme`, `notify` (Toast and best-effort native notifications)

### File and network range

Two permissions carry a declared range as well as a name, because a switch cannot say "read
broadly but leak nothing". `manifest.fs` says which paths each file mode may touch and
`manifest.net.domains` lists the hostnames the plugin may reach:

```json
{
  "permissions": ["fs.read", "fs.write", "fs.delete", "net.fetch"],
  "fs": {
    "read": { "scope": ["**/*"] },
    "write": { "scope": ["out/**"] },
    "delete": { "own": true }
  },
  "net": { "domains": ["api.example.com", "*.githubusercontent.com"] }
}
```

- Globs are relative to the root: `*` covers one segment, `**` crosses separators. `fs.read`
  may ask for the whole tree; `fs.write` and `fs.delete` may not — a whole-tree pattern fails
  manifest validation.
- An absent or empty declaration grants nothing. A file access outside the scope reaches the
  user as a native confirmation (allow once / allow this session / deny); an empty
  `net.domains` means no egress at all, whatever `net.fetch` says.
- Credentials are refused whatever the manifest says: `.env*`, `.ssh/`, `.aws/`, `.git/`,
  `*.pem`, and the app's own data directory. Symlinks are resolved first, so a link out of the
  workspace does not get through.
- `"delete": { "own": true }` reaches the files this plugin wrote and nothing else — the usual
  right answer for cleaning up your own output. Deletes are never recursive, go to the
  operating-system trash, and are rate-braked at 50 per minute.
- `"root": "userSelected"` needs no scope: `pi.fs.requestDirectory()` asks the user to pick a
  directory, the handle is memory-only, and it dies with the plugin process.
- Large-file plugins should use `fs.stat` and bounded `fs.readRange` instead of raw `node:fs`.
  Panel plugins may call `pluginBridge.getDroppedFilePath(file)` and then
  `fs.registerDropped` to obtain a one-file, session-only read grant for a real drop.

The pre-scope names (`fs.read.workspace` and friends) still load, but the host downgrades
them — `fs.write.workspace` ends up able to write nothing until the manifest says where.

`pi.ui.notify` shows an in-app Toast. A plugin may call
`pi.ui.getNotificationPermission()`, then
`pi.ui.requestNotificationPermission()`, and finally
`pi.ui.showNativeNotification({ title, body })` for OS-level delivery. The
permission result is best-effort (`granted`, `denied`, `unknown`, or
`unsupported`) because Electron has no cross-platform read-only native
notification permission query. Native plugin notifications do not enter the
durable task notification inbox.

Supported host API groups are `app`, `plugin`, `commands`, `ui`, `workspace`, `fs`, `agent`,
`services`, `bus`, `clipboard`, `shell`, `net`, and `events`. There is no host archive,
arbitrary process, or network-server API. Skills, themes, and MCP servers are declarative
manifest contributions rather than runtime registration APIs.

Prefer these host APIs over raw Node file or network APIs. The permission gateway covers the
host API surface; the separate Node plugin process is not yet an operating-system capability
sandbox, so only load code from a trusted source.

## Declarative contributions

A file listed in `contributes.skills` is indexed for the Agent's `Skill` tool, so it needs
`agent.prompt.inject`. Without that permission the file is simply ignored. Give each skill
`name` and `description` front matter — the description is what tells the model when to load
it:

```markdown
---
name: Release notes
description: the user asks for release notes or a changelog entry
---

Write one line per user-visible change, imperative mood, newest first.
```

The prompt receives only a bounded catalog; a selected body is read on demand. A plugin may
contribute 32 skills, each at most 128 KiB, with descriptions capped at 240 characters. Keep
them short and specific; a skill that always applies wastes context.

Themes need `ui.theme`; local and remote MCP servers need `mcp.server.local` and
`mcp.server.remote` respectively. A resident service must be declared in
`contributes.services`, granted `background.service`, and registered with `pi.services`.
Bus publish topics and subscribe patterns must be declared under `contributes.bus` and use
their matching permissions. Never put secrets in theme CSS, manifests, MCP literal values, or
bus payloads.

## Packaging

A `.piplug` is a **store-only (uncompressed) zip** — the installer rejects deflated entries.
Always produce one with `PluginPack`, never with `zip` or `tar`. `.git`, `node_modules` and
`dist` are excluded automatically; the package must stay under 2000 files and 50 MB, and may
not contain symlinks.
