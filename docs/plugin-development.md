# PI-Desktop Plugin Development: Zero to One

This guide is the shortest complete path from an empty folder to a tested
`.piplug` package. It describes the plugin runtime that PI-Desktop ships today.
The files under [`docs/spec/07-plugins`](spec/07-plugins/README.md) remain the
normative contract when this guide and a specification differ.

## 1. What a plugin can add

A plugin can contribute one or more of these capabilities:

| Capability | Use it for | Main building blocks |
|---|---|---|
| Command | An explicit action in global search | `contributes.commands`, `pi.commands.register` |
| Panel | A small isolated HTML interface | `ui.panel`, `ui.panel` permission, `window.pluginBridge` |
| Work panel view | An interface docked in the app's right work panel | `contributes.views`, `ui.view` permission, `window.pluginBridge` |
| Agent tool | A function the Agent can call | `contributes.agentTools`, `pi.agent.registerTool` |
| Skill | Instructions loaded by the Agent on demand | `contributes.skills`, `agent.prompt.inject` permission |
| Theme | Design-token overrides | `contributes.themes`, `ui.theme` permission |
| MCP server | Tools discovered from a local or remote MCP server | `contributes.mcpServers`, an MCP permission |
| Service | Resident work supervised by the host | `contributes.services`, `background.service` permission |
| Message bus | Typed-by-convention events between plugins | `contributes.bus`, bus permissions |

Plugin entry code runs in a dedicated Node process. Panels run in sandboxed,
context-isolated Electron windows with no Node integration. Calls from either
surface cross a host-owned permission gateway.

> **Trust boundary:** the permission model gates the `pi.*` host API and panel
> bridge. It is not yet an operating-system sandbox for raw Node APIs used by a
> plugin entry process. Load development plugins and third-party packages only
> when you trust their source, and use the host API instead of direct Node file
> or network access. See the [security specification](spec/07-plugins/04-plugin-security.md).

## 2. Prerequisites

For the recommended app-first path, you need:

- a running PI-Desktop build;
- an empty folder for the plugin; and
- a text editor.

For the repository CLI path, you also need Node.js 22.19 or newer, pnpm 10 or
newer, and a checkout of this repository. The devkit and SDK are currently
private workspace packages, so do not assume that `npm install
@pi-desktop/plugin-devkit` works outside this repository.

## 3. Create the first plugin

### Option A: create it in PI-Desktop

1. Open **Plugins** (the Extensions page).
2. Open the header overflow menu and choose **New plugin from template**.
3. Choose `panel-basic`.
4. Select an empty folder.

PI-Desktop writes the starter files, loads the folder as a development plugin,
and opens the folder as the active project. The plugin is live immediately.

The four built-in templates are:

| Template | Starts with | Permissions |
|---|---|---|
| `panel-basic` | Command and HTML panel | `ui.panel` |
| `agent-tool-basic` | Agent-callable echo tool | `agent.tool.register` |
| `skill-pack` | One skill document | `agent.prompt.inject` |
| `full-demo` | Command, panel, tool, skill, and setting | The permissions used by those features |

Scaffolding refuses a non-empty destination so it cannot silently overwrite an
existing project.

### Option B: create it with the repository CLI

From the PI-Desktop repository root:

```bash
pnpm install
pnpm --filter @pi-desktop/plugin-devkit... build
pnpm pi-plugin init panel-basic ../my-first-plugin \
  --id local.my-first-plugin \
  --name "My First Plugin"
```

Then open PI-Desktop, go to **Plugins**, choose **Load development plugin**, and
select `../my-first-plugin`.

Use a reverse-domain id for a published plugin, for example
`com.example.workspace-summary`. The `local.` prefix is a useful convention for
private plugins. Keep the id stable: settings, data, grants, updates, and the
package name are keyed by it.

## 4. Understand the generated files

The `panel-basic` template produces:

```text
my-first-plugin/
├── manifest.json
├── main.js
├── README.md
└── renderer/
    └── index.html
```

- `manifest.json` declares identity, entry points, contributions, and requested
  permissions.
- `main.js` runs in the plugin process and exports lifecycle hooks.
- `renderer/index.html` runs in the isolated panel window.
- `README.md` explains how to develop and package this particular plugin.

Distribution packages must contain directly executable JavaScript, HTML, CSS,
and assets. PI-Desktop does not install dependencies or compile TypeScript when
it loads a plugin. If you use TypeScript or third-party packages, bundle or
compile them into the plugin directory before checking and packing it.

## 5. Build the minimal plugin by hand

The following three files show the complete command-to-panel path.

### `manifest.json`

```json
{
  "schemaVersion": 1,
  "id": "local.my-first-plugin",
  "name": "My First Plugin",
  "version": "0.1.0",
  "description": "Opens a panel and shows a greeting.",
  "main": "main.js",
  "ui": {
    "panel": "renderer/index.html",
    "title": "My First Plugin",
    "width": 480,
    "height": 360
  },
  "contributes": {
    "commands": [
      {
        "id": "my-first-plugin.open",
        "title": "My First Plugin: Open Panel",
        "keywords": ["hello", "panel"]
      }
    ]
  },
  "permissions": ["ui.panel"],
  "engines": {
    "piDesktop": ">=0.1.0"
  },
  "activationEvents": [
    "onCommand:my-first-plugin.open",
    "onStartup"
  ]
}
```

`schemaVersion`, `id`, `name`, `version`, and `main` are required. Every file
path is relative to the plugin root and must stay inside it. Declare only the
permissions the plugin actually needs.

### `main.js`

```js
async function onLoad() {
  await pi.commands.register({
    id: "my-first-plugin.open",
    title: "My First Plugin: Open Panel",
    keywords: ["hello", "panel"],
    run: async () => {
      await pi.ui.openPanel({ title: "My First Plugin" });
      await pi.ui.showToast("Hello from My First Plugin");
    },
  });
}

async function onUnload() {
  await pi.commands.unregister("my-first-plugin.open");
}

module.exports = { onLoad, onUnload };
```

The host injects `pi` as a global. `onLoad` and `onUnload` receive no arguments.
CommonJS is the simplest entry format; ESM is also loaded when the entry is an
ES module. Module evaluation plus `onLoad` has a 15-second budget. `onUnload`
has a 5-second budget and is best-effort, so release timers and subscriptions
promptly.

Only `onLoad` and `onUnload` are fired today. Other lifecycle names in the
manifest are reserved for the planned full lifecycle.

### `renderer/index.html`

PI-Desktop hosts the panel in a frameless window on every platform. The host
reserves exactly a transparent 46 CSS px drag band and renders a minimal fixed
capsule in the top-right corner with minimize, maximize/restore, and close
buttons. The panel title, toolbar, and all other visible UI belong to the
plugin. Normal-flow content is automatically offset below the drag band, so do
not add another 46px top padding to compensate. The drag band is not clickable
outside the capsule; development panels show a reminder for this constraint.

If a panel uses `position: fixed` or `position: sticky` for a top toolbar,
anchor it below the host drag band instead of using `top: 0`:

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

The host does not inject a panel title. Keep the 46px drag band in mind for
viewport-height calculations as well:
`height: calc(100dvh - var(--pi-plugin-titlebar-height, 46px))`.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My First Plugin</title>
  </head>
  <body>
    <h1>My First Plugin</h1>
    <button id="hello">Show toast</button>
    <script>
      document.getElementById("hello").addEventListener("click", async () => {
        await window.pluginBridge.invoke("ui.showToast", {
          message: "Hello from the panel",
        });
      });
    </script>
  </body>
</html>
```

The panel does not receive the global `pi` object. It receives only
`window.pluginBridge`, and arbitrary Electron IPC channels are unavailable.

## 6. Add capabilities

### 6.1 Agent tool

Declare the tool and its permission:

```json
{
  "contributes": {
    "agentTools": [
      {
        "name": "summarize_text",
        "description": "Summarize text supplied by the agent.",
        "risk": "low",
        "schema": {
          "type": "object",
          "properties": {
            "text": { "type": "string" }
          },
          "required": ["text"]
        }
      }
    ]
  },
  "permissions": ["agent.tool.register"]
}
```

Register the matching handler during `onLoad`:

```js
await pi.agent.registerTool({
  name: "summarize_text",
  description: "Summarize text supplied by the agent.",
  risk: "low",
  schema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  execute: async (args, context) => {
    context.log("summarize_text called");
    const text = String(args?.text ?? "");
    return { summary: text.slice(0, 120) };
  },
});
```

Unregister it in `onUnload`. The host exposes it to the model under a
plugin-namespaced name, applies the normal Agent permission policy, audits
execution, and enforces a 110-second plugin-side timeout. Plugin tools are not
available in Plan mode.

### 6.2 Skill

Add a file such as `skills/release-notes.md`:

```markdown
---
name: Release notes
description: Use when the user asks for release notes or a changelog entry.
---

# Release notes

Write one line per user-visible change. Use imperative mood and put the newest
change first.
```

Declare it with the required permission:

```json
{
  "contributes": {
    "skills": ["skills/release-notes.md"]
  },
  "permissions": ["agent.prompt.inject"]
}
```

The prompt receives a short skill catalog; the full body is read on demand.
Each plugin may contribute up to 32 skills, each file may be at most 128 KiB,
and descriptions are capped at 240 characters. A skill without
`agent.prompt.inject` is ignored rather than loaded.

### 6.3 Settings and private data

Declare defaults in the manifest:

```json
{
  "contributes": {
    "settings": [
      {
        "key": "greeting",
        "title": "Greeting",
        "type": "string",
        "default": "Hello"
      }
    ]
  }
}
```

Read and update them from the plugin process:

```js
const settings = await pi.plugin.getSettings();
await pi.plugin.setSettings({ greeting: "Welcome" });
const dataPath = await pi.plugin.getDataPath();
```

Settings and the data path are private to the plugin id. The installed Plugins
page generates controls for `string`, `number`, `boolean`, `select`, `json`, and
`shortcut` fields. A shortcut field must name a declared command:

```json
{
  "key": "openShortcut",
  "title": "Open panel shortcut",
  "type": "shortcut",
  "default": "Mod+Shift+H",
  "command": "hello.open",
  "scope": "plugin"
}
```

Plugin shortcuts run only in the focused PI-Desktop window and are checked
against the app shortcut map. Global registration is not supported yet. The
plugin receives `plugin:settingsChanged` after a user edit. Do not put
credentials in `manifest.json` or source control.

### 6.4 Workspace files, clipboard, network, and notifications

These APIs require explicit permissions:

| Permission | Plugin-process API | Panel bridge channel |
|---|---|---|
| `fs.read` | `pi.fs.readText`, `pi.fs.glob`, `pi.fs.list`, `pi.fs.requestDirectory` | `fs.readText`, `fs.glob`, `fs.list` |
| `fs.write` | `pi.fs.writeText` | `fs.writeText` |
| `fs.delete` | `pi.fs.remove` | Not exposed |
| `clipboard.read` | `pi.clipboard.readText`, `pi.clipboard.getHistory` | `clipboard.readText`, `clipboard.getHistory` |
| `clipboard.write` | `pi.clipboard.writeText` | `clipboard.writeText` |
| `net.fetch` | `pi.net.fetch` | `net.fetch` |
| `shell.openExternal` | `pi.shell.openExternal` | `shell.openExternal` |
| `notify` | `pi.ui.notify`, `pi.ui.getNotificationPermission`, `pi.ui.requestNotificationPermission`, `pi.ui.showNativeNotification` | `ui.notify`, `ui.getNotificationPermission`, `ui.requestNotificationPermission`, `ui.showNativeNotification` |

Use `fs.list` rather than `fs.glob` when you are showing a tree: it returns one
directory at a time (name-sorted, directories included), so the user expands
what they want instead of waiting on a whole-repo walk that is capped at 500
matches. Both obey the same read scope.

A file permission is only half the declaration: `manifest.fs` says which paths
each mode may touch (see §6.5). Paths are relative to the mode's root. Absolute
paths and `..` escapes are rejected, as is a symlink that leaves the root.
`fs.remove` is non-recursive, moves the path to the OS trash, and cannot remove
the root itself. `net.fetch` accepts HTTP(S) and only reaches hosts listed in
`manifest.net.domains`; `openExternal` accepts HTTP(S) and `mailto:` URLs.

`pi.ui.notify` shows an in-app Toast. Native notifications are opt-in: call
`pi.ui.requestNotificationPermission()` before
`pi.ui.showNativeNotification(...)`. The returned permission is best-effort
because Electron does not expose a cross-platform read-only OS permission API;
`unknown` means the platform has not reported a result yet, and
`unsupported` means desktop notifications are unavailable. Native plugin
notifications are not added to PI-Desktop's durable task notification inbox.

The panel bridge also exposes `ui.showToast`, `ui.closePanel`,
`plugin.getSettings`, and `workspace.get`. A channel the host does not implement
itself is forwarded to your `onPanelInvoke(channel, payload)`, so a panel can
talk to its own plugin over channels you define; a plugin that exports no
`onPanelInvoke` gets `UNSUPPORTED` back.

### 6.5 File scope

`fs.read` / `fs.write` / `fs.delete` say whether your plugin may touch files.
`manifest.fs` says which ones:

```json
{
  "permissions": ["fs.read", "fs.write", "fs.delete"],
  "fs": {
    "read": { "scope": ["**/*"] },
    "write": { "scope": ["docs/**", "*.md"] },
    "delete": { "own": true, "scope": ["dist/**"] }
  }
}
```

- `scope` globs are relative to the root. `*` matches one segment, `**` crosses
  separators.
- **Reading** may declare the whole tree. **Writing and deleting may not** — a
  whole-tree pattern fails validation, because the egress allowlist is what makes
  a broad read safe and nothing makes a broad write safe.
- An access outside the declared scope is not an error: PI-Desktop asks the user
  (Deny / Allow once / Allow this session). Declare the scope you need so your
  plugin does not interrupt them on every call, and expect a refusal to arrive as
  `PERMISSION_DENIED`.
- Some paths are refused whatever you declare: `.env*`, SSH and cloud
  credentials, `*.pem`, `.git/**`, and PI-Desktop's own data directory. They do
  not appear in `fs.glob` results either.

**Deleting.** `own: true` lets you remove files your plugin wrote itself, with no
scope and no prompt — the right default for cleaning up your own output. (If the
user has edited the file since you wrote it, it stops counting as yours.)
Deleting anything else needs a `scope`. Every delete is non-recursive, goes to the
OS trash, and is interrupted once past 50 removals a minute, so batch cleanups
should be paced rather than run as a `glob` plus a loop.

**Working outside the workspace.** Set `"root": "userSelected"` on a mode and call
`pi.fs.requestDirectory()`: the user picks a directory and you get full reach
inside it with no scope to declare. The handle lives in memory and is gone when
the plugin process exits, so ask again each session.

**Legacy names.** `fs.read.workspace`, `fs.write.workspace` and
`fs.delete.workspace` still load, but are cut back — write reaches nothing and
delete reaches only your own output — until the manifest declares `fs`. The
Plugins page tells the user this happened.

### 6.6 Network access

`net.fetch` lets your plugin make a request; `manifest.net.domains` says where to:

```json
{
  "permissions": ["net.fetch"],
  "net": { "domains": ["api.example.com", "*.githubusercontent.com"] }
}
```

Entries are bare hostnames — no scheme, no port, no path — and a leading `*.`
covers the domain and its subdomains. A bare `*` is refused at install.

The list is the single allowlist for **every** outbound path the host owns, not
only `pi.net.fetch`: your panel's own `fetch`, `<img>`, `<script>` and stylesheet
loads answer to it too (a sandboxed panel still has a network stack), as do
remote HTTP MCP servers you declare. `window.open` from a panel is refused
outright.

An omitted, empty, or malformed `net.domains` means **no egress at all**, even
with `net.fetch` granted. Redirects are followed by hand and re-checked, so an
allowed host cannot bounce a request to one you did not declare. Bundle assets
into the plugin rather than loading them from a CDN you would otherwise have to
declare.

### 6.7 Theme

Declare a CSS file and `ui.theme`:

```json
{
  "contributes": {
    "themes": [
      {
        "id": "midnight",
        "label": "Midnight",
        "path": "themes/midnight.css",
        "base": "dark"
      }
    ]
  },
  "permissions": ["ui.theme"]
}
```

Override PI-Desktop design tokens in that CSS. The host sanitizes contributed
CSS, refuses imports and non-data URLs, caps each file at 256 KiB, and allows up
to eight themes per plugin. The user selects the theme in Settings.

### 6.8 Work panel view

A view is an interface docked in the app's right work panel, next to Review,
Terminal, Browser, and Files. It is the same isolated page as `ui.panel` — you
can reuse the same HTML — but it is shown inside the main window instead of a
separate one, which suits anything the user consults while reading the
conversation: a change list, a file tree, an issue queue.

```json
{
  "contributes": {
    "views": [
      {
        "id": "changes",
        "title": { "en": "Changes", "zh-CN": "改动" },
        "icon": "diff",
        "entry": "views/changes.html",
        "order": 10
      }
    ]
  },
  "permissions": ["ui.view"]
}
```

Declare as many as the plugin needs; each becomes its own row in the panel's
header menu. `title` may be a plain string or an `{ en, "zh-CN" }` object.
`order` sorts the rows and defaults to declaration order.

`icon` is a token from a fixed list the host draws from its own icon set —
`bell`, `book`, `bot`, `branch`, `browser`, `chat`, `clock`, `diff`, `files`,
`folder`, `image`, `key`, `link`, `list-checks`, `palette`, `plug`,
`pull-request`, `search`, `server`, `shield`, `sparkles`, `target`, `terminal`,
`workflow`, `wrench`. A plugin cannot supply its own SVG, because the icon is
drawn inside host chrome. An unknown token is not an error: it renders as a
lettered tile, and `pi-plugin check` warns about it.

Inside the page, `window.pluginBridge` works exactly as in a panel window. The
one difference is the chrome: a docked view has no window controls and no drag
band, so read `--pi-plugin-titlebar-height` instead of hard-coding `46px` and
the same file lays out correctly in both placements.

```css
body {
  /* 0px docked, 46px in a panel window. */
  padding-top: calc(var(--pi-plugin-titlebar-height, 0px) + 12px);
}
```

A view is confined the same way a panel window is: sandboxed page, no Node, the
plugin's own persisted session partition, and network limited to
`manifest.net.domains` (§6.6). It is also filtered by activation scope — a
plugin restricted to certain projects does not offer its views in others.

`examples/plugins/hello` ships a working view at `views/greetings.html`, and
PI-Desktop's own **Files** panel is a bundled plugin built the same way —
`apps/desktop/resources/plugins/pi.files` is a complete, non-toy example of a
view that reads the workspace over the bridge.

### 6.9 MCP server

MCP servers are declarative. A local server requires `mcp.server.local`; a
remote server requires `mcp.server.remote`:

```json
{
  "contributes": {
    "mcpServers": [
      {
        "id": "docs",
        "label": "Documentation tools",
        "transport": "stdio",
        "command": "bin/docs-server",
        "args": ["--stdio"],
        "env": {
          "DOCS_TOKEN": { "setting": "docsToken" }
        }
      },
      {
        "id": "issues",
        "transport": "http",
        "url": "https://mcp.example.com/tools",
        "headers": {
          "Authorization": { "setting": "issuesAuthorization" }
        }
      }
    ]
  },
  "permissions": ["mcp.server.local", "mcp.server.remote"]
}
```

A stdio command must be a bare command found on `PATH` or a plugin-relative
executable; absolute paths are rejected. Remote URLs may use HTTP or HTTPS, and
the host must be listed in `net.domains`; non-loopback HTTP is unencrypted, so
use it only on a trusted network. Setting references read only this plugin's
settings—the host environment and provider secrets are never forwarded. MCP
tools follow the same Agent-only policy and namespacing as hand-written plugin
tools.

### 6.10 Resident service and message bus

Declare service ids and allowed topics:

```json
{
  "contributes": {
    "services": [
      { "id": "watcher", "label": "Workspace watcher" }
    ],
    "bus": {
      "publish": ["example.index.ready"],
      "subscribe": ["example.build.*"]
    }
  },
  "permissions": [
    "background.service",
    "bus.publish",
    "bus.subscribe"
  ]
}
```

Register matching handlers:

```js
let unsubscribe;

pi.services.register({
  id: "watcher",
  start: ({ log }) => log("watcher started"),
  stop: () => {},
});

unsubscribe = await pi.bus.subscribe("example.build.*", async (message) => {
  await pi.bus.publish("example.index.ready", {
    source: message.from,
    at: message.at,
  });
});
```

Call `unsubscribe()` during unload. A plugin does not receive its own bus
messages. Treat topics as public to any installed plugin with a matching
subscription; never put secrets in the payload.

## 7. Permission design

Permissions are both declared in `manifest.json` and granted by the user.
Undeclared or ungranted API calls fail with `PERMISSION_DENIED`.

| Risk | Permissions |
|---|---|
| Low | `ui.panel`, `ui.view`, `ui.theme`, `notify` |
| Medium | `clipboard.read`, `clipboard.write`, `fs.read`, `shell.openExternal`, `background.service`, `bus.publish`, `bus.subscribe` |
| High | `fs.write`, `fs.delete`, `agent.tool.register`, `agent.prompt.inject`, `net.fetch`, `mcp.server.local`, `mcp.server.remote` |

Two permissions carry a declared range as well as a name, and the user is shown
both: `manifest.fs` for the file modes (§6.5) and `manifest.net.domains` for
egress (§6.6). Both fail closed — an absent or empty declaration grants nothing,
so a plugin that says nothing about them reaches nothing.

Ask for the smallest set possible. Adding a permission to a loaded development
plugin does not take effect through hot reload: PI-Desktop stops the reload and
asks the user to load the folder again so the new grant can be reviewed. Widening
`manifest.fs` counts as adding a permission for this purpose. Removing
permissions takes effect on reload.

The complete mapping and policy are in the
[permission matrix](spec/07-plugins/13-plugin-permissions-matrix.md).

## 8. Develop and debug

### Hot reload

Development plugins are watched after the first folder load and across app
restarts. Changes reload after a 300 ms debounce. `.git`, `node_modules`,
`dist`, `target`, and common editor scratch files are ignored.

A reload performs `unload → validate → load`. Panel memory is not preserved. A
syntax or manifest error unloads the broken version but keeps the watcher
active; save a fix to recover. At most 16 development plugins are watched at
once.

### Verify each contribution

- Run a command from global search (`Cmd/Ctrl+K` or `Cmd/Ctrl+Shift+P`).
- Open a panel from the command or the plugin row.
- Ask the Agent to call the contributed tool while in Agent mode.
- Ask for a task matching the skill description, then inspect whether the
  skill is selected.
- Select a contributed theme in Settings.
- Inspect the plugin row for service state and restart count.

### Logs and failures

Load, crash, permission, tool, network, service, and bus activity is recorded in
the application logs. Open **Settings → Info → Logs**, then search for the
plugin id. User-facing load and hot-reload failures also appear as a toast and
on the plugin row when a persisted load error is available.

Host API failures throw an `Error` with a `code`, commonly
`PERMISSION_DENIED`, `NOT_FOUND`, `INVALID_ARGUMENT`, `TIMEOUT`, `UNSUPPORTED`,
`LIMIT_EXCEEDED`, or `RATE_LIMITED`. Catch errors around optional operations
and include the code in diagnostics without logging secrets.

## 9. Check, pack, and install

Run validation from the repository root:

```bash
pnpm pi-plugin check ../my-first-plugin
```

`check` reports blocking errors and non-blocking warnings. It validates the
manifest, referenced files, permissions, path containment, symlinks, package
size, and file count using the same rules as installation. Review warnings too,
especially unused and high-risk permissions.

Pack only with the devkit:

```bash
pnpm pi-plugin pack ../my-first-plugin
```

The result is:

```text
../my-first-plugin/dist/local.my-first-plugin-0.1.0.piplug
```

The command prints the package SHA-256. A `.piplug` is a store-only
(uncompressed) ZIP; normal `zip` defaults usually produce an archive the
installer rejects. The devkit excludes `.git`, `node_modules`, and `dist`,
rejects symlinks, and enforces a maximum of 2,000 files and 50 MiB.

To test the exact artifact users receive:

1. Open **Plugins**.
2. Choose **Install plugin package** from the header overflow menu.
3. Select the generated `.piplug`.
4. Review the permissions and install it.
5. Repeat the contribution checks from the previous section.
6. Disable and re-enable it to verify cleanup and startup behavior.
7. Uninstall it and confirm its contributions disappear.

The Agent can also run `PluginCheck` in every operating mode. `PluginScaffold`
and `PluginPack` are Agent-mode tools and are restricted to the current
workspace.

## 10. Prepare a release

Before sharing a package:

1. Use a stable reverse-domain plugin id.
2. Update `version` with semantic versioning.
3. Set `engines.piDesktop` to the versions you actually support.
4. Document every command, setting, tool input, permission, and external
   service in the plugin README.
5. Add a changelog and a license.
6. Build all generated JavaScript and assets into the plugin folder.
7. Run `pi-plugin check` and resolve every error and unexpected warning.
8. Run `pi-plugin pack` and install the resulting package in a clean app state.
9. Record the printed SHA-256 next to the release artifact.

For the official marketplace, submit the package and catalog metadata to
[`vastsa/pi-desktop-plugins`](https://github.com/vastsa/pi-desktop-plugins) and
follow that repository's `CONTRIBUTING.md`. The marketplace catalog is a
separate repository; adding a plugin here does not publish it.

Signatures are not the current trust primitive. Package SHA-256 and explicit
permission review are the implemented baseline; follow the
[signing and updates specification](spec/07-plugins/08-plugin-signing-updates.md)
for roadmap details.

## 11. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `manifest.json is missing` | Wrong directory selected | Select the directory whose root contains `manifest.json` |
| `main entry missing` | `main` points to source that was not built | Compile/bundle first or correct the relative path |
| Panel does not open | Missing file, `ui.panel`, or permission | Declare the panel path and `ui.panel`; reload for a new grant |
| View is missing from the work panel menu | Missing `ui.view`, missing entry file, or the plugin's activation scope excludes the open project | Declare `ui.view`, check `views[].entry` exists, and set the scope to Global or to this project |
| View shows a letter tile instead of an icon | Unknown `views[].icon` token | Use a token from the supported list; `pi-plugin check` warns about unknown ones |
| `pluginBridge` is unavailable | HTML opened in a normal browser | Test bridge calls inside the PI-Desktop panel |
| Tool never appears | Missing contribution, registration, or grant | Align `agentTools`, `registerTool`, and `agent.tool.register`; use Agent mode |
| Skill never applies | Missing permission or weak metadata | Add `agent.prompt.inject` and specific `name`/`description` front matter |
| Save reports `PERMISSION_DENIED` | Manifest widened permissions | Load the development folder again and review the new grant |
| Hot reload stops after a syntax error | Broken plugin is unloaded | Save the corrected file; the watcher remains active |
| Package install rejects compression | Archive was made with a generic ZIP tool | Rebuild it with `pi-plugin pack` |
| MCP server does not start | Invalid transport fields, command, URL, setting, or permission | Run `pi-plugin check`, then inspect logs by plugin id |
| Service repeatedly restarts | `start` throws or the plugin process exits | Make `start` idempotent, clean up in `stop`, and inspect the restart log |

## 12. Reference map

- [Example plugins](https://github.com/vastsa/PI-Desktop/tree/main/examples/plugins)
- [Plugin system overview](spec/07-plugins/01-plugin-system.md)
- [Manifest schema](spec/07-plugins/02-plugin-manifest-schema.md)
- [Host API](spec/07-plugins/03-plugin-api.md)
- [Lifecycle](spec/07-plugins/05-plugin-lifecycle.md)
- [Packaging](spec/07-plugins/06-plugin-packaging.md)
- [Developer experience](spec/07-plugins/10-plugin-devex.md)
- [Permissions](spec/07-plugins/13-plugin-permissions-matrix.md)
- [Hello reference plugin](https://github.com/vastsa/PI-Desktop/tree/main/examples/plugins/hello)
