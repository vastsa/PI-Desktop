# PI-Desktop Plugin Development: Zero to One

This guide is the shortest complete path from an empty folder to a tested
`.piplug` package. It describes the plugin runtime that PI-Desktop ships today.
The SDK types, host validators, runtime dispatch, and executable tests are the
implementation evidence. The files under [`docs/spec/07-plugins`](spec/07-plugins/README.md) remain the
normative contract when this guide and a specification differ.

## 1. What a plugin can add

A plugin can contribute one or more of these capabilities:

| Capability | Use it for | Main building blocks |
|---|---|---|
| Command | An explicit action in global search | `contributes.commands`, `pi.commands.register` |
| Panel | A small isolated HTML interface | `ui.panel`, `ui.panel` permission, `window.pluginBridge` |
| Floating widget | A transparent, frameless companion window — a round orb, not a rectangle | `ui.panel` permission, `"ui": { "shape": "widget" }`, `window.pluginBridge` |
| Work panel view | An interface docked in the app's right work panel | `contributes.views`, `ui.view` permission, `window.pluginBridge` |
| Agent tool | A function the Agent can call | `contributes.agentTools`, `pi.agent.registerTool` |
| OAuth provider | A provider row with host-owned sign-in and encrypted credentials | `contributes.providers`, `provider.oauth`, `onProviderOAuth` |
| One-shot completion | A host-owned completion against the user's models | `pi.models.list`, `pi.session.getLlmContext`, `pi.agent.complete` |
| Skill | Instructions loaded by the Agent on demand | `contributes.skills`, `agent.prompt.inject` permission |
| Theme | Design-token overrides | `contributes.themes`, `ui.theme` permission |
| MCP server | Tools discovered from a local or remote MCP server | `contributes.mcpServers`, an MCP permission |
| Service | Resident work supervised by the host | `contributes.services`, `background.service` permission |
| Message bus | Typed-by-convention events between plugins | `contributes.bus`, bus permissions |
| Renderer slot | UI drawn inside the app's own window: composer controls, message action bars, blocks below a reply, tool cards, code-block renderers, corner layers | `renderer`, `renderer.extension` permission, `packages/plugin-sdk/src/renderer.ts` |
| Composer suggestion | One dismissible line offered to the input box, taken with Tab | `pi.composer.suggest`, `composer.suggest` permission |
| Provider | API-key, no-auth, or OAuth model service | `contributes.providers`, `provider.register`; OAuth also needs `provider.oauth` |
| Session import | Import, read, rename, and delete this plugin's own history | `contributes.sessionSources`, matching `session.*` grants |
| Usage facts | Compute your own usage dashboard | `pi.usage.listTurns`, `usage.read` |
| Composer transform | An explicit draft-text action with undo | `contributes.composerTransforms`, `onComposerTransform`, `composer.transform` |
| Global shortcut | Invoke your command while the app is unfocused | `contributes.globalShortcuts`, `pi.keyboard`, `keyboard.globalShortcut` |
| Trusted agent extension | pi ExtensionAPI hooks, tools, commands, and custom agents | `contributes.agentExtensions`, `agent.extension` |
| Real-time connection | Host-owned, bounded WebSockets | `pi.net.websocket`, `net.websocket` |
| Browser / desktop control | Reviewed browser or app operations | `pi.browser`, `browser.cdp`; `pi.desktop`, `desktop.control` |
| Speech adapter | Add a speech protocol handled by the plugin process | `pi.speech`, `speech.adapter.register` |

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
- To import a pi extension directory with npm dependencies, a system `npm` executable must be on `PATH`. Release builds ship no standalone Node/npm; without it, PI-Desktop reports a warning and the imported dependency cannot load.

For the repository CLI path, use the Node.js and pnpm versions declared in the
root `package.json` (`engines` and `packageManager`) and a checkout of this
repository. The devkit and SDK are currently
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

`schemaVersion`, `id`, `name`, `version`, and `main` are required. Entry, view,
and skill paths are relative to the plugin root and must stay
inside it. Theme assets have a separately validated external-path route (§6.7).
Plugin ids must match `^[a-z0-9]+(\.[a-z0-9_-]+)+$`; uppercase and undotted
ids are rejected. `activationEvents` is descriptive metadata today, not a lazy
activation scheduler: enabled plugins load at startup or explicit enable/load.
Declare only the permissions the plugin actually needs.

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

Only `onLoad` and `onUnload` are lifecycle hooks today. Export them from the
entry module; there is no `entrypoints` manifest dispatcher. `onPanelInvoke`,
`onRendererCall`, `onComposerTransform`, and `onProviderOAuth` are operation
callbacks. `onInstall`, `onEnable`, `onDisable`, and `onUninstall` are not called.
During app quit the unload budget is shortened to 1.5 seconds.

`onProviderOAuth` is a separate operation callback for OAuth provider
contributions, not a lifecycle hook. It handles login and refresh only for its
own declared provider. The host stores its returned credential encrypted and
passes only the access token to model requests; the callback can also use
`pi.providers.oauth.prompt` and `.notify` for host-rendered login steps. The
permission `provider.oauth` is high risk, and token egress still requires
`net.fetch` plus the manifest's network domains. See the provider OAuth section
in the [Plugin API](spec/07-plugins/03-plugin-api.md).

### `renderer/index.html`

PI-Desktop hosts the panel in a frameless window on every platform. The host
reserves exactly a transparent 46 CSS px drag band and renders a minimal fixed
capsule in the top-right corner with minimize, maximize/restore, and close
buttons. The panel title, toolbar, and all other visible UI belong to the
plugin. New pages should declare `<meta name="pi-plugin-chrome" content="v2">` and
apply `var(--pi-plugin-titlebar-height, 0px)` to their own top spacing once.
Without this marker the host retains the legacy additive offset; do not add a
second 46px spacer to those pages. The drag band is not clickable
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

### Floating widgets

A plugin whose whole interface is a small floating shape — a voice orb, a timer,
a status light — declares `"ui": { "shape": "widget" }` in its manifest instead
of accepting a rectangle with a toolbar strip. The panel then opens as a
transparent, frameless window:

- no 46px drag band and no capsule; `--pi-plugin-titlebar-height` is `0px`
- empty space drags the window, while a standard control — or any element marked
  `data-pi-plugin-no-drag` — stays clickable
- right-click on the surface opens the host menu: close, minimize, always on top
- `ui.width` / `ui.height` are honoured down to 120×120, and `ui.alwaysOnTop`
  pins the widget above other windows
- the page can read `document.documentElement.dataset.piPluginPanelShape`
  (`panel` | `widget` | `view`) to style one HTML entry for every placement

Draw the silhouette yourself — `border-radius: 50%`, your own shadow, a glow that
bleeds past the shape — and keep the page background transparent outside it, so
the window disappears behind the shape. Everything else, `window.pluginBridge`,
permissions, settings, is identical to a panel.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="pi-plugin-chrome" content="v2" />
    <title>My First Plugin</title>
    <style>body { padding-top: var(--pi-plugin-titlebar-height, 0px); }</style>
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
execution, and enforces a 110-second plugin-side timeout. Tools are deferred
behind `ToolSearch`. By default they are hidden and denied in Plan/Goal. A tool
may opt in with `planSafeActions` on its **runtime registration**, naming its
read-only `action` values; keep the manifest descriptor in sync. Registration
checks the list against a schema action enum when present, and execution in
Plan/Goal requires `args.action` to be in that list. Risk `low`, a session grant,
or `auto` cannot substitute for it. See [the API contract](spec/07-plugins/03-plugin-api.md#agent).
Use `context.signal` for cancellation and `context.sessionId` / `turnId` to
associate async work with the invoking turn. Never substitute the visible session.

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
against the app shortcut map. For OS-global bindings use the separate
`contributes.globalShortcuts` and
`pi.keyboard` surface with `keyboard.globalShortcut` (§6.17). The
plugin receives `plugin:settingsChanged` after a user edit. Do not put
credentials in `manifest.json` or source control.

### 6.4 Workspace files, clipboard, network, and notifications

These APIs require explicit permissions:

| Permission | Plugin-process API | Panel bridge channel |
|---|---|---|
| `fs.read` | `pi.fs.readText`, `stat`, `readRange`, `readPreview`, `openDefault`, `openInBrowser`, `reveal`, `glob`, `list`, `requestDirectory` | The same `fs.*` names; dropped-file grants use `fs.registerDropped` |
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
each mode may touch (see §6.5). Paths are relative to the mode's root. An Agent tool uses its calling session's
project root; a panel uses the visible workspace or its view's browsed folder.
Registered project-group roots support reviewed absolute-path file actions;
this does not make arbitrary absolute paths valid for general file I/O. Absolute
paths and `..` escapes are rejected, as is a symlink that leaves the root.
`fs.remove` is non-recursive, moves the path to the OS trash, and cannot remove
the root itself. `net.fetch` accepts HTTP(S) and only reaches hosts allowed by
`manifest.net.domains` or the separately reviewed `net.anyHost` grant; `openExternal` accepts HTTP(S) and `mailto:` URLs.

`pi.ui.notify` shows an in-app Toast. Native notifications are opt-in: call
`pi.ui.requestNotificationPermission()` before
`pi.ui.showNativeNotification(...)`. The returned permission is best-effort
because Electron does not expose a cross-platform read-only OS permission API;
`unknown` means the platform has not reported a result yet, and
`unsupported` means desktop notifications are unavailable. Native plugin
notifications are not added to PI-Desktop's durable task notification inbox.
Clicking a delivered notification restores and focuses the main window, but
does not activate a session.

The panel bridge also exposes `ui.showToast`, `ui.closePanel`,
`plugin.getSettings`, `workspace.get`, and `projects.list`. A channel the host
does not implement itself is forwarded to your `onPanelInvoke(channel, payload)`, so a panel can
talk to its own plugin over channels you define; a plugin that exports no
`onPanelInvoke` gets `UNSUPPORTED` back.

`pi.projects.list()` adds project-picker support without requiring an active
session or a manifest permission. Entries use the decimal `projects.id` as
`projectId`, include ungrouped projects, and always provide `primaryPath` and
primary-first `roots`. A stopped or unavailable Host returns `[]`. See the
[project API contract](spec/07-plugins/03-plugin-api.md#projects-workspace-fs).

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

Without `net.anyHost`, an omitted or empty `net.domains` means **no egress**,
even with `net.fetch` granted; malformed declarations fail validation.
`net.anyHost` is an install-time high-risk exception for user-entered endpoints,
not a request-time prompt. It also covers WebSockets, panel traffic, and remote
MCP, but still blocks cloud-metadata destinations and grants no fetch/socket API
by itself. Redirects are followed by hand and re-checked, so an
allowed host cannot bounce a request to one you did not declare. Bundle assets
into the plugin rather than loading them from a CDN you would otherwise have to
declare.

`fetch` returns what the server answered, `429` and `Retry-After` included: the
host never retries a request your plugin makes, so backoff after a rate limit is
your own policy rather than a hidden host behaviour. A call that comes back
`>= 400` is still audited, as `ok: false` with the delay the response advertised.

### Fetch redirect policy

Check host support before relying on a policy; old hosts can ignore unknown
request fields. Never fall back to a raw network request.

```js
if (typeof pi.net.getCapabilities !== "function") throw new Error("Upgrade PI-Desktop");
const capabilities = await pi.net.getCapabilities();
if (!capabilities.fetchRedirectModes.includes("error")) throw new Error("Unsupported host");
const response = await pi.net.fetch({ url: endpoint, redirect: "error" });
```

`error` rejects every 3xx with `REDIRECT_DISALLOWED` before accessing Location.
`manual` returns the original status, headers and body. Omitted/`follow` retains
the existing bounded, per-hop egress-checked behavior. Invalid modes are rejected
before I/O. No mode expands network permissions. See the
[complete contract](spec/07-plugins/03-plugin-api.md#net) and the
local-only test plugin at `examples/plugins/fetch-redirect/README.md` in the repository.

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
        "base": "dark",
        "assets": ["themes/background.svg"]
      }
    ],
    "windowAppearance": {
      "backgroundColor": { "dark": "#141a24", "light": "#f5f7fa" }
    }
  },
  "permissions": ["ui.theme", "ui.window.appearance"]
}
```

`base` selects the built-in `light` or `dark` palette underneath the overrides;
omitting it defaults to `dark`. The user selects the contributed theme in Settings.

Match the base palette's selector when overriding design tokens:

```css
:root[data-theme="dark"] { --ds-bg-primary: #141a24; }
:root[data-theme="light"] { --ds-bg-primary: #f5f7fa; }
```

The theme stylesheet is appended after the host styles, but later source order
wins only when selector specificity is equal. The host palette selectors are
`:root[data-theme="dark"]` and `:root[data-theme="light"]`; a bare `:root`
has lower specificity and is not sufficient to override those declarations.
For a light-base theme, explicitly use `:root[data-theme="light"]`.

The host sanitizes CSS, rejects `@import` and `url()` targets other than `data:`
URIs or declared theme assets,
caps each stylesheet at 256 KiB, and imposes no per-plugin theme-count cap. Optional
`assets` accepts `png`, `jpg`, `jpeg`, `webp`, `avif`, `svg`, and `woff2` files,
with a summed limit of 4 MiB. Paths may be package-relative (inside the plugin
root, without traversal or `node_modules`) or absolute. Matching CSS URLs are
rewritten to registered, read-only `plugin-asset://` URLs; unloading the plugin
revokes them. The renderer never receives the raw filesystem path.

Optional `contributes.windowAppearance.backgroundColor` supplies `light`/`dark`
colors in `#rrggbb` or `#rrggbbaa` form and requires `ui.window.appearance` in
addition to `ui.theme`. It applies only while that plugin's theme is selected;
switching away restores the host background. On macOS the default translucent
window ignores the color; turning off **Translucent window** applies it to the
opaque native surface. `cornerRadius` accepts integer 0..24 DIP: Windows 11
uses square corners for 0 and its system-rounded preference for positive values.
macOS keeps native corners.
See the [manifest contract](spec/07-plugins/02-plugin-manifest-schema.md) for
all theme and window-appearance fields.


Runtime theme changes do not require reload: `pi.themes.upsert`, `remove`,
`list`, and `pi.app.setTheme` use `ui.theme`. `pi.themes.setVariables(themeId,
values)` accepts only that theme's declared typed variables (`length`, `number`,
`color`, `select`), not arbitrary CSS or host-reserved tokens.
`contributes.scenicThemes` adds a host-rendered Settings card selector with
1..12 cards and requires both `ui.settings` and `ui.theme`. Arbitrary
`settingsDestinations` HTML/JS entries are not a public contribution.

### 6.8 Work panel view

A view is an interface docked in the app's right work panel, alongside the
host's other tool and resource tabs. It is the same isolated page as `ui.panel` — you
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
PI-Desktop's own file view is a bundled plugin built the same way —
`apps/desktop/resources/plugins/pi.file-manager` is a complete, non-toy example
of a view that reaches the workspace over the public bridge: `fs.openDefault`
and `fs.reveal` for the two actions only the host can perform, and its plugin-owned
`onPanelInvoke` operations. Custom channels must validate their own payloads;
they are not automatically converted into permission-gated `pi.fs` calls.

### 6.9 MCP server

MCP servers are declarative. A local server requires `mcp.server.local`; a
remote server requires `mcp.server.remote`:

```json
{
  "contributes": {
    "settings": [
      { "key": "docsMode", "title": "Docs mode", "type": "string", "default": "public" },
      { "key": "clientName", "title": "Client name", "type": "string", "default": "my-plugin" }
    ],
    "mcpServers": [
      {
        "id": "docs",
        "label": "Documentation tools",
        "transport": "stdio",
        "command": "bin/docs-server",
        "args": ["--stdio"],
        "env": {
          "DOCS_MODE": { "setting": "docsMode" }
        }
      },
      {
        "id": "issues",
        "transport": "http",
        "url": "https://mcp.example.com/tools",
        "headers": {
          "X-Client-Name": { "setting": "clientName" }
        }
      }
    ]
  },
  "permissions": ["mcp.server.local", "mcp.server.remote"],
  "net": { "domains": ["mcp.example.com"] }
}
```

A stdio command must be a bare command found on `PATH` or a plugin-relative
executable; absolute paths are rejected. `npx` and `uvx` are resolved to the
real Node.js / uv binaries (PATH, official Node, fnm, nvm, Volta, default uv
install). On Windows, `python3` and `python` skip the Microsoft Store alias for
a real interpreter on `PATH`, falling back to `py -3`. Remote URLs may use
HTTP or HTTPS, and the host must be listed in `net.domains`; non-loopback HTTP is unencrypted, so use it only on a trusted
network. Setting references read only this plugin's settings—the host
environment and provider secrets are never forwarded. MCP tools follow the
same deferred tool catalog and namespacing as hand-written plugin tools.
Plugin MCP tools default to medium risk and are not Plan-safe merely because
the server describes them as read-only.

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

### 6.11 Agent extension (pi ExtensionAPI module)

A plugin can ship code that runs inside the agent process itself: a module
written against the pi CLI `ExtensionAPI`, an explicit subset of the pi extension contract. It registers tools, slash commands, and hooks on every turn, tool call,
and provider request. Declare the modules and the `agent.extension`
permission:

```json
{
  "contributes": { "agentExtensions": ["src/index.ts"] },
  "permissions": ["agent.extension"]
}
```

```ts
// src/index.ts
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

export default function (pi) {
  pi.registerTool(defineTool({
    name: "fx_add", label: "Add", description: "Adds two numbers",
    parameters: Type.Object({ a: Type.Number(), b: Type.Number() }),
    async execute(_id, { a, b }) {
      return { content: [{ type: "text", text: String(a + b) }], details: {} };
    },
  }));
  pi.on("tool_call", (event) =>
    event.toolName === "Bash" ? { block: true, reason: "not here" } : undefined,
  );
  pi.registerCommand("greet", {
    description: "Say hello",
    async handler(args, ctx) {
      const name = await ctx.ui.input("Your name?");
      ctx.ui.notify(`Hello ${name} ${args}`);
    },
  });
}
```

What to know before you use it:

- **It is not sandboxed.** The module runs in the agent process with the
  same access as the agent's own tools. `agent.extension` is a high-risk
  permission the user confirms explicitly; the manifest is rejected if you
  list modules without it.
- **TypeScript is fine.** Modules are loaded with jiti, so `.ts` needs no
  build step. `typebox`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`,
  and `@earendil-works/pi-coding-agent` resolve to the app's copies;
  `@earendil-works/pi-tui` resolves to an inert stub, so terminal-UI calls
  do nothing and show up as diagnostics.
- **Tools are deferred.** Like plugin tools, the model activates them
  through `ToolSearch` on demand. Names that collide with core or plugin
  tools are rejected with a diagnostic.
- **Slash commands** appear in the composer `/` menu and global search and
  take the rest of the line as `args`. `ctx.ui.input` / `select` / `confirm`
  open native dialogs; `ui.notify` is a toast.
- **Supported members** are listed in spec 07-plugins/16 §5. Unsupported
  ones (`setWidget`, `registerMessageRenderer`, `navigateTree`, and the
  other terminal-only surfaces) are inert and reported in the plugin row's
  details, never thrown.
- **Import existing pi extensions** against the supported-member table in spec 16: Plugins → overflow menu →
  "Import pi extension" wraps a file or directory in a generated plugin. If
  the directory declares production or optional dependencies, PI-Desktop first
  runs `npm install --package-lock-only --omit=dev --legacy-peer-deps --no-audit
  --no-fund --ignore-scripts`, validates the generated registry-only lockfile,
  then runs `npm ci` with the same safety flags. Direct dependency specs are
  checked across production, optional, dev, and peer fields; git resolution is
  disabled, and no third-party lifecycle script runs. A native module that
  needs a build script fails with a diagnostic — rebuild it against Electron
  headers (`npx @electron/rebuild -v <electron version>`) inside the plugin
  directory to fix it. Failed installs clean partial dependencies and report a
  warning toast without blocking the import; the row shows a load error only if
  the extension actually fails to load.


### 6.12 Renderer slots

Every surface above is a window or a page the plugin owns. A **renderer module**
draws inside PI-Desktop's own window instead: controls in the composer toolbar,
items on a message's action bar, a block below an assistant reply, the card for
one of your own Agent tools, a renderer for a fenced code block, or a corner
layer you manage yourself.

```json
{
  "permissions": ["renderer.extension"],
  "renderer": "renderer/index.mjs",
  "rendererActions": ["plugin.call", "composer.insertText"],
  "rendererCallMethods": ["openWorkspace"]
}
```

The entry exports `onLoad(pi)`, the host evaluates it in its own window, and
every load is handed a fresh `pi`. Components read the host through the module's
own copy of it, because a component's props carry data and nothing else:

```js
import React from "react";

let host = null;

function InsertButton() {
  return React.createElement(
    "button",
    { onClick: () => host.dispatch("composer.insertText", { text: "hello" }) },
    "Insert",
  );
}

export function onLoad(pi) {
  host = pi;
  pi.slots.register({ slot: "composerControl", component: InsertButton, positions: ["right"] });
}
```

- `composerControl` — controls in the composer toolbar; `positions: ["left"]`
  or `["right"]` selects a side, omitted means both
- `composerTrigger` — the item list behind one of the composer's trigger
  symbols: `{ slot: "composerTrigger", trigger: "#", items }`, and the host draws
  the list
- `userAction` / `assistantAction` — items on a message's action bar
- `entryExtra` — a block below an assistant reply
- `toolCard` — the card for calls of one of your own Agent tools; `toolName`
  names it
- `blockRenderer` — a fenced block tagged `<your-plugin-id>:<lang>`; `language`
  names the tag

A dialog you draw yourself is not a slot: `pi.ui.openLayer()` hands you a layer
to render into, and the component draws inside it. Styles go through
`pi.ui.injectStyle`, and `react`, `react/jsx-dev-runtime`,
`react/jsx-runtime`, `react-dom` and `react-dom/client` resolve to the app's copies
through the window's import map, so no bundled React is needed.

`rendererActions` whitelists what a component may dispatch — `plugin.call`,
`composer.insertText`, `composer.readDraft`, `composer.replaceDraft`,
`attachments.add`, `attachments.list`, `attachments.remove`, at most 16 — and
`rendererCallMethods` whitelists the method names `onRendererCall` answers for
`plugin.call`, at most 32. A dispatch outside those lists is refused with
`PLUGIN_ACTION_UNDECLARED` and a word outside the vocabulary with
`PLUGIN_ACTION_UNKNOWN`. The module runs in the app's own document with the
app's own React, so `renderer.extension` is a high-risk permission: grant it
only to code you trust.

`examples/plugins/ui-slots-lab` mounts a sample on every slot.
`packages/plugin-sdk/src/renderer.ts` carries the types and each slot's props,
and the manifest side is [spec 07-plugins/02 §3.2](spec/07-plugins/02-plugin-manifest-schema.md).
### 6.13 Model providers and OAuth

Declare providers with `provider.register`. The host owns the provider row,
API-key form, encrypted secret storage, and model requests; a plugin never
receives a key entered into Add Service. The provider id becomes
`plugin:<pluginId>:<id>`. Categories and descriptions accept strings or
`{ en, "zh-CN" }` labels.

```json
{
  "permissions": ["provider.register"],
  "contributes": {
    "providers": [{
      "id": "example",
      "name": "Example AI",
      "category": "Example services",
      "description": "Models from your Example account.",
      "baseUrl": "https://api.example.com/v1",
      "apiStyle": "chat_completions",
      "authKind": "api_key",
      "models": []
    }]
  }
}
```

An empty model list is allowed only for an API-key provider with `baseUrl`:
after key save the host discovers the endpoint's models. Otherwise declare
1..64 models per provider. There is no per-plugin provider-count cap. Supported
API styles are `chat_completions`, `opencode_go`, `responses`,
`anthropic_messages`, `google_generative_ai`, `openai_codex_responses`, and
`pi_messages`; auth kinds are `api_key`, `none`, and `oauth`.

OAuth additionally requires `provider.oauth`, `baseUrl`, and
`onProviderOAuth(request, { signal })`. Handle `login` and `refresh`, returning
`{ accessToken, refreshToken?, expiresAt?, accountLabel?, headers? }`. Only a
refresh receives that contribution's existing credential. Use
`pi.providers.oauth.prompt(loginId, input)` / `.notify(loginId, event)` for
host-rendered interaction; respond to cancellation. The host keeps refresh
tokens out of the renderer and Agent Runtime. Use the host network gateway
with separate `net.fetch` and egress declarations for token requests.
Disabling a plugin retains and disables its provider rows; removing a provider
declaration or uninstalling deletes its row and stored credential.

### 6.14 Follow sessions, import history, and read usage

Use `pi.session.getActive()` and `session:activated` for the selected session.
No new permission is required, but activation scope still applies. The answer
is `null` away from chat, or `{ sessionId, projectPath, activeTurn }`, where
`activeTurn` is `null` or `{ turnId, startedAt }`. Treat snapshots as values
that can become stale across an `await`.

`session:turnEnded` carries `{ sessionId, turnId, reason }` with `completed`,
`aborted`, or `error`. Delivery is once per settled host turn to a live plugin,
without acknowledgement or replay. It does not prove every late tool has
exited. Subscribe and unsubscribe with the same function reference.

```js
function onSession(snapshot) {
  if (!snapshot) return;
  console.log("Selected session", snapshot.sessionId);
}

async function onLoad() {
  pi.events.on("session:activated", onSession);
  onSession(await pi.session.getActive());
}

function onUnload() {
  pi.events.off("session:activated", onSession);
}

module.exports = { onLoad, onUnload };
```

History management is a separate ownership boundary. Declare
`contributes.sessionSources: [{ id: "archive", label: "Archive" }]`, then use:

| Task | Methods | Permission |
|---|---|---|
| Import history | `session.import`, `session.importBatch` | `session.import` |
| Read imported history | `session.list`, `get`, `listMessages` | `session.read.own` |
| Rename imported session | `session.rename` | `session.update.own` |
| Trash or purge imported session | `session.delete` | `session.delete.own` |
| Create/reuse an explicit project binding | `project.create`; import with `projectId` | `project.create` |
| Generate a default title | `session.getAutoTitleContext`, `setAutoTitle` | `session.autoTitle` |
| Read completed-turn usage facts | `usage.listTurns` | `usage.read` |

Import is idempotent on `(pluginId, source, externalId)`. Use strict RFC3339
timestamps, monotonic message times, and the host-generated ids returned by
import. Imported provider/model/path strings are historical metadata, not live
bindings. Supply an existing `projectId` to bind a project; creating it does not
activate the workspace. Host-owned `sessionsChanged` refreshes the UI.

Reads and mutations address only this plugin's imported sessions. Batch `skip`
continues per item; `fail` is atomic. `trash` preserves transcript/origin and
`purge` deletes both. There is no general message-mutation or arbitrary
session-rebinding API. Auto-title exposes only the bounded first prompt/reply
for default-titled sessions and uses compare-and-set `expectedTitle`; a manual
rename wins. Usage facts contain counters and identifiers, never message bodies.
See [session contracts](spec/07-plugins/03-plugin-api.md) for payloads and limits.

### 6.15 Model catalog and one-shot completions

`pi.models.list()` (`models.list`) returns ready model bindings without
credentials. Pass the returned `key` unchanged to `pi.agent.complete`
(`agent.complete`); do not split a model id that may itself contain `/`.

```js
const models = await pi.models.list();
const model = models.find((item) => item.isDefault) ?? models[0];
if (!model) throw new Error("Configure a model first");
const answer = await pi.agent.complete({
  modelKey: model.key,
  system: "Answer briefly.",
  messages: [{ role: "user", content: "Explain this plugin's purpose." }],
});
await pi.ui.showToast(answer.text);
```

This spends the user's provider quota and uses no tools. The host owns auth,
provider error classification, and bounded provider retries. It enforces a 90s
budget and eight calls per plugin per rolling minute. `includeSessionContext`
also needs `session.read` and an active invocation of this plugin's Agent tool;
`session.getLlmContext()` has the same invocation-only rule. A background
service, Composer transform, or selected-session snapshot does not grant a
transcript read. Handle `TIMEOUT`, `RATE_LIMITED`, and classified provider
failures rather than retrying indefinitely.

### 6.16 Composer transforms and suggestions

A transform is invoked by the user and receives only `{ id, text, modelKey? }`.
Declare `contributes.composerTransforms` and `composer.transform`, then export:

```js
function onComposerTransform({ id, text }) {
  if (id !== "trim") throw new Error("Unknown transform");
  return text.trim();
}

module.exports = { onComposerTransform };
```

Declare `{ "id": "trim", "title": "Trim draft", "undoTitle": "Undo trim" }`
in that contribution. Input and output each allow 100,000 characters. The host
preserves file references, rejects stale edit/session results, and offers undo.
The callback gets no transcript, attachment data, or separate file-path metadata.

A suggestion is a separate `pi.composer` process API with `composer.suggest`.
It offers a placeholder line while the draft is empty; it never sends text.

```js
const active = await pi.session.getActive();
if (active) {
  const result = await pi.composer.suggest({
    sessionId: active.sessionId,
    turnId: active.activeTurn?.turnId,
    text: "Add a regression test for this change",
    ttlMs: 120_000,
  });
  if (!result.shown) console.log("Suggestion refused", result.reason);
}
// On your own cancellation path:
await pi.composer.clearSuggestion();
```

Text is folded to one line and cut at 200 characters; TTL defaults to 120s
and clamps to 1..600s. The user takes it with Tab or dismisses it with Esc.
Typing, pasting, adding an attachment, sending, switching session, a new turn,
unload, renderer reload, and window close clear it. Normal refusals return
`{ shown: false, reason }` (`session-not-visible`, `draft-not-empty`,
`stale-turn`, `replaced`, `unsupported`); malformed input or a missing grant
still throws. For work triggered by `session:turnEnded`, pass that event's
`turnId` so a late completion cannot suggest for a newer turn.

### 6.17 Global shortcuts, WebSockets, microphone, and speech

Global shortcuts are separate from app-local `shortcut` settings. Declare an
id and your own command under `contributes.globalShortcuts`, grant
`keyboard.globalShortcut`, and register the command in `onLoad`. A `default`
accelerator is registered after load; use `pi.keyboard.registerGlobalShortcut`
for runtime changes. Check `registered` and `error` in the result; conflicts
are returned as `registered: false`, not thrown. The host releases bindings on
unload, disable, and crash. There are at most eight per plugin.

WebSockets require `net.websocket` and the same egress policy as fetch. Use
`pi.net.websocket.connect` / `send` / `close` and `pi.events` events
`net:websocket:open`, `message`, `close`, `error` (each with the full prefix and
owning `socketId`). Four sockets, 1 MiB frames, and 4 MiB queued sends are the
host bounds. The host closes them with the plugin.

`ui.microphone` grants audio-only `getUserMedia` inside an isolated panel;
camera remains denied. Background `pi.audio.*` has types and permission gates
but **no device backend**: authorized calls return/throw `UNSUPPORTED`.
Do not build a working background recorder on that declaration alone.

`pi.speech.registerAdapter` / `unregisterAdapter` (`speech.adapter.register`)
adds a protocol handler. Return text, audio, or a host-executed HTTP plan.
Built-in ids `openai_audio` and `openai_chat_audio` are reserved; a plan carrying
a bound provider key must stay on that provider origin.

### 6.18 Browser and desktop operations

`fs.openInBrowser(path)` needs only `fs.read`, opens an existing readable HTML
file in a work-panel resource tab, and grants no browser automation. Use
`browser.cdp` only for `pi.browser.*` automation. Those calls are bound to the
invoking tool session; a background session cannot retarget the visible page.
CDP is allowlisted, and cookie/storage/target/network-interception methods stay
denied. `browser.reveal()` is explicit presentation and need not precede a
background navigation. Full-page captures are scaled to at most 1280×2048 and
have a 30s capture deadline.

`desktop.control` exposes `pi.desktop.listOperations()` and
`pi.desktop.invoke({ operation, args, confirm? })` over a reviewed catalog,
never arbitrary IPC. Dangerous operations require `confirm: true` **and** the
user's answer in a host-owned native dialog. Session collaboration `spawn` and
`send` additionally require an active plugin Agent tool invocation; the host
supplies source session/turn identity. Read the [desktop-control contract](spec/07-plugins/03-plugin-api.md)
before using operations that create, prompt, cancel, or delete sessions.

## 7. Permission design

Permissions are both declared in `manifest.json` and granted by the user.
Undeclared or ungranted API calls fail with `PERMISSION_DENIED`.

| Risk | Permissions |
|---|---|
| Low | `ui.panel`, `ui.view`, `ui.theme`, `ui.settings`, `ui.window.appearance`, `notify` |
| Medium | `ui.microphone`, `clipboard.read`, `clipboard.write`, `fs.read`, `composer.transform`, `composer.suggest`, `models.list`, `session.read.own`, `session.update.own`, `usage.read`, `shell.openExternal`, `background.service`, `bus.publish`, `bus.subscribe`, `audio.playback.background`, `keyboard.globalShortcut` |
| High | `fs.write`, `fs.delete`, `agent.tool.register`, `agent.prompt.inject`, `agent.complete`, `agent.extension`, `renderer.extension`, `provider.register`, `provider.oauth`, `desktop.control`, `project.create`, `session.read`, `session.import`, `session.delete.own`, `session.autoTitle`, `net.fetch`, `net.anyHost`, `mcp.server.local`, `mcp.server.remote`, `browser.cdp`, `audio.capture.background`, `speech.adapter.register`, `net.websocket` |

`keyboard.globalShortcut` and `net.websocket` are implemented. `pi.audio.*`
exists and is callable, and its methods keep their permission gate, but this
host has no device backend yet: an authorized call is answered with a coded
`UNSUPPORTED` refusal that is audited, and `onInputFrame` / `offInputFrame`
throw the same code synchronously, until the device service lands and replaces
the refusal with real capture and playback.

Two permissions carry a declared range as well as a name, and the user is shown
both: `manifest.fs` for the file modes (§6.5) and `manifest.net.domains` for
egress (§6.6). Without the separately reviewed `net.anyHost` exception, an absent network
range grants no egress. An absent file scope grants no standing reach;
out-of-scope file operations still require host-owned consent.

Ask for the smallest set possible. Adding a permission to a loaded development
plugin does not take effect through hot reload: PI-Desktop stops automatic reload so the new grant can be reviewed. Use the
plugin row's **More → Reload** action to explicitly review/reload the registered
folder, or load the development folder again. Widening
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
size, and file count before packing. A clean result does not prove runtime loading, compatibility,
permission grants, or plugin-center approval; test the packed artifact too. Review warnings too,
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
installer rejects. The devkit excludes `.git`, `node_modules`, and root `dist`, and omits
credential files (`.env`, `.env.*`, `.npmrc`, `*.pem`, `*.key`) with a warning. It
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

### Prepare a plugin center submission with `pi-plugin publish`

`publish` packs the plugin and pins the package to the git commit it was built
from, so the plugin center can rebuild and compare the artifact:

```bash
pnpm pi-plugin publish ../my-first-plugin [--out <dir>] [--ref <ref>] [--channel stable|beta] [--allow-dirty]
```

`publish` prepares files locally; it does not upload or publish a version.
Ignore `dist/` in the plugin repository before running it, because packing
happens before the clean-worktree check.

The command runs the same `check` and `pack` steps, then reads the `origin`
remote and `HEAD` of the plugin's repository. SSH remotes are rewritten to the
canonical `https://` form; remotes with embedded credentials or a non-HTTPS
scheme are rejected. The working tree must be clean unless you pass
`--allow-dirty`, which produces a submission the center cannot reproduce and
prints a warning. The pinned `ref` is `--ref` when given, otherwise the tag
that points at `HEAD` as `refs/tags/<tag>`; without a tag the bare commit is
submitted with a warning. The plugin's path relative to the repository root is
recorded so a plugin may live in a subdirectory.

The result is `dist/<id>-<version>.submission.json` (or `--out`), a
`schemaVersion: 1` payload with `pluginId`, `version`, `channel`, the
`source` pin (`repository`, `ref`, `commit`, `path`), the `artifact`
(`publisher-release` mode, file name, SHA-256, size), the declared
`permissions`, and an `idempotencyKey` that is stable per plugin, version,
commit, and artifact so a retried submission is not a new release. Attach the
`.piplug` to a release on that commit, then submit the payload to the plugin
center. The center re-resolves the source from the forge and does not trust
the recorded values.

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

For the official marketplace, publish on the plugin center,
[plugins.aiuo.net](https://plugins.aiuo.net): create the plugin, bind the repository it lives in,
tag the version and submit it — from the console, or with the publishing skill over MCP. The
center packs the files, audits the source, records the SHA-256 and publishes the version, then
mirrors the catalog and packages to
[AIUO-Net/pi-desktop-plugins](https://github.com/AIUO-Net/pi-desktop-plugins) for the GitHub
backup channel. Plugin sources are never hosted in the distribution repository, and pull requests
that add them are closed.

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
| Save reports `PERMISSION_DENIED` | Manifest widened permissions or file scope | Use More → Reload or load the folder again to review the new grant |
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

## 13. Complete SDK surface and source map

This inventory follows `PluginHostApi` in `packages/plugin-sdk/src/index.ts`.
It is a method index, not a blanket grant. The permission matrix, invocation
context, and availability restrictions above still apply; `pi.audio` remains
unsupported. The panel bridge is a smaller surface listed in API spec §6.

| Namespace | Methods |
|---|---|
| `pi.app` | `getVersion`, `getLocale`, `getAppearance`, `setTheme` |
| `pi.themes` | `upsert`, `remove`, `list`, `setVariables` |
| `pi.plugin` | `getId`, `getManifest`, `getSettings`, `setSettings`, `getDataPath` |
| `pi.commands` | `register`, `unregister` |
| `pi.speech` | `registerAdapter`, `unregisterAdapter` |
| `pi.composer` | `suggest`, `clearSuggestion` |
| `pi.ui` | `openPanel`, `closePanel`, `showToast`, `notify`, `getNotificationPermission`, `requestNotificationPermission`, `showNativeNotification`, `revealView` |
| `pi.project` | `create` |
| `pi.providers.oauth` | `prompt`, `notify` |
| `pi.workspace` | `get` |
| `pi.projects` | `list` |
| `pi.desktop` | `listOperations`, `invoke` |
| `pi.audio` | `getInputDevices`, `openInput`, `closeInput`, `getCaptureState`, `onInputFrame`, `offInputFrame`, `openOutput`, `writeOutput`, `stopOutput`, `closeOutput` |
| `pi.keyboard` | `registerGlobalShortcut`, `unregisterGlobalShortcut`, `listGlobalShortcuts` |
| `pi.fs` | `readText`, `stat`, `readRange`, `readPreview`, `openDefault`, `openInBrowser`, `reveal`, `writeText`, `glob`, `list`, `remove`, `requestDirectory` |
| `pi.agent` | `registerTool`, `unregisterTool`, `complete` |
| `pi.models` | `list` |
| `pi.session` | `getLlmContext`, `getActive`, `getAutoTitleContext`, `setAutoTitle`, `list`, `get`, `listMessages`, `import`, `importBatch`, `rename`, `delete` |
| `pi.usage` | `listTurns` |
| `pi.services` | `register`, `unregister` |
| `pi.bus` | `publish`, `subscribe` |
| `pi.clipboard` | `readText`, `writeText`, `getHistory` |
| `pi.shell` | `openExternal` |
| `pi.browser` | `reveal`, `navigate`, `action`, `setBounds`, `setVisible`, `getState`, `openExternal`, `snapshot`, `screenshot`, `click`, `fill`, `evaluate`, `console`, `cdp` |
| `pi.net` | `getCapabilities`, `fetch` |
| `pi.net.websocket` | `connect`, `send`, `close` |
| `pi.events` | `on`, `off` |

Renderer modules use a different `pi`: `plugin.id` / `version`,
`slots.register`, `ui.injectStyle`, `ui.openLayer`, `composer.subscribeDraft`,
and `dispatch`. Draft subscriptions require `composer.readDraft` in
`rendererActions`. Draft replacements use the captured `generation` as `expectedGeneration`,
require a user input event while the Composer is unfocused, and preserve every
host chip; inspect `renderer-composer.ts` rather than writing
host store state. No renderer action sends a message.

| Code / tests | What to verify |
|---|---|
| `packages/plugin-sdk/src/index.ts`, `renderer.ts`, `renderer-composer.ts` | Public types, contributions, permission vocabulary, renderer actions |
| `packages/plugin-sdk/src/{fs-policy,net-policy,theme-css,theme-variables,mcp-config}.ts` | Scope, egress, CSS, variable, and MCP validation |
| `packages/plugin-devkit/src/{templates,check,walk,pack,publish,cli}.ts` | Template files, checks, exclusions, archive format, submission preparation |
| `crates/host-core/src/plugins/{manifest,validation,install,registry}.rs` | Actual install, persistence, compatibility, and uninstall rules |
| `apps/desktop/electron/main/plugin-runtime.ts`, `plugin-host-process.mjs` | Broker dispatch, process callbacks, lifecycle, events, audit, and limits |
| `apps/desktop/electron/preload/plugin-panel.ts` | Actual panel bridge and page-owned chrome |
| `apps/desktop/test/plugin-*.test.mjs` | Host API, lifecycle, invocation scope, and representative plugin paths |
| `examples/plugins/hello`, `ui-slots-lab`, `fetch-redirect`, `roundtable` | Working contributions and focused probes |

`docs/plugin-plan` contains slot/API review pages and proposed runtime hooks.
A draft page is not an implemented SDK export. Start with the current SDK and
runtime when deciding whether a capability exists. The built-in authoring
instructions are shipped at `apps/desktop/resources/skills/plugin-development.md`.
