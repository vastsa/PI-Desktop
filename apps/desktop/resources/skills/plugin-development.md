---
name: PI-Desktop plugin development
description: the user is writing, checking, packaging or debugging a PI-Desktop plugin
---

You are working inside a PI-Desktop plugin. Use the `PluginScaffold`, `PluginCheck` and
`PluginPack` tools instead of hand-rolling files or shell commands — they enforce the same
authoring and package-safety rules. A clean check is preparation, not proof of
runtime compatibility, permission grants, successful loading, or marketplace approval.

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
    "settings": [{ "key": "greeting", "title": "Greeting", "type": "string", "default": "Hello" }]
  }
}
```

`schemaVersion`, `id`, `name`, `version` and `main` are required. `id` must match
`^[a-z0-9]+(\.[a-z0-9_-]+)+$`; prefix personal plugins with `local.`. Entry, view, and skill paths are relative to the plugin directory and may not
escape it; declared theme assets have a separately validated external-path route.
`activationEvents` is metadata, not a lazy-loading scheduler. `engines.piDesktop`
does not replace testing on the oldest supported host. Export callbacks from the
entry module; there is no `entrypoints` manifest dispatcher.

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

Module evaluation plus `onLoad` has 15s; `onUnload` has 5s (1.5s on quit); agent
tools and Composer transforms have 110s. An
uncaught error during load rolls the whole load back and leaves the plugin in `load_error`.
Only `onLoad` and `onUnload` are lifecycle hooks today. `onPanelInvoke`,
`onRendererCall`, `onComposerTransform`, and `onProviderOAuth` are separate
operation callbacks; `onInstall`, `onEnable`, `onDisable`, and `onUninstall`
are not called.

## Panel UI

PI-Desktop hosts every panel in a frameless window. The host reserves exactly a
transparent 46px drag band and renders only a minimal fixed capsule in the
top-right with minimize, maximize/restore, and close controls. The panel title,
toolbar, background, and every other visible surface belong to the plugin.
New pages declare `<meta name="pi-plugin-chrome" content="v2">` and apply
`var(--pi-plugin-titlebar-height, 0px)` as page-owned top spacing once. Pages
without the marker retain the legacy additive offset; do not add another 46px
spacer there. Widgets and docked views use 0px. The drag band is not clickable outside the capsule; development
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
`workspace.get`, `session.getActive`, `ui.revealView`, `fs.readText`, `fs.stat`,
`fs.readRange`, `fs.readPreview`, `fs.openDefault`, `fs.openInBrowser`, `fs.reveal`,
`fs.list`, `fs.requestDirectory`, `fs.writeText`, `fs.glob`, `clipboard.readText`,
`clipboard.getHistory`, `clipboard.writeText`, `shell.openExternal`, `app.getAppearance`, `app.setTheme`, `themes.*`,
`models.list`, `net.getCapabilities`, and `net.fetch`. The bridge does not expose
`plugin.setSettings`, `fs.remove`, `agent.complete`, or general process APIs.
Unknown channels are forwarded to this plugin's `onPanelInvoke(channel, payload)`;
validate their payloads yourself. Arbitrary Electron IPC is not exposed.
Read `app.getAppearance` through the bridge for locale and react to
`appearance:changed`; plugin-owned UI must localize itself.

## Renderer slots

A panel draws in its own window. A plugin that instead draws inside PI-Desktop's own window —
controls in the composer, items on a message's action bar, a card for its own agent tool, a
corner layer — declares a renderer entry module and asks for `renderer.extension`:

```json
{
  "permissions": ["renderer.extension"],
  "renderer": "renderer/index.mjs",
  "rendererActions": ["plugin.call", "composer.insertText"],
  "rendererCallMethods": ["openWorkspace"]
}
```

The entry is an ES module that the host evaluates in its own window; the host hands it the
renderer API, and the module registers components with `pi.slots.register({ slot, component })`.
A component is a React function component that imports React from the host's import map
(`import React from "react"`). Every registration returns a disposer and all of them run when
the plugin unloads. The slots are:

- `composerControl` — controls in the composer toolbar; `positions` picks left, right, or both
- `composerTrigger` — the list behind one of the composer's trigger symbols: you supply the
  items, the host draws the list
- `userAction` / `assistantAction` — items on a message's action bar; `positions` picks a side
- `entryExtra` — a block below an assistant reply
- `toolCard` — the card for calls of one of your own agent tools; `toolName` names it
- `blockRenderer` — a fenced code block tagged `<your-plugin-id>:<lang>`

A dialog you draw yourself is not a slot: `pi.ui.openLayer()` hands you a layer to render into.
Styles go through `pi.ui.injectStyle`, and the host is otherwise reached with `pi.dispatch`.

Declare what you reach for. `rendererActions` whitelists the actions a component may dispatch —
`plugin.call`, `composer.insertText`, `composer.readDraft`, `composer.replaceDraft`,
`attachments.add`, `attachments.list`, `attachments.remove`, at most 16 — and
`rendererCallMethods` whitelists the method names your `onRendererCall` answers for
`plugin.call`, at most 32. A call outside those lists is refused, so a component can only act
inside its own plugin. The module shares PI-Desktop's own document, so this is a contract rather
than a sandbox: enable only code you trust.

`examples/plugins/ui-slots-lab` mounts a sample on every slot, and
`packages/plugin-sdk/src/renderer.ts` carries the types and the props each slot receives.

## Permissions

Every permission is declared in the manifest and granted at install time; an undeclared call
fails at runtime. Ask for the least you need — the plugins page shows the risk tier to the
user.

Use the complete matrix in `docs/spec/07-plugins/13-plugin-permissions-matrix.md`
when working in the host repository. Major gates include:

- `ui.panel` / `ui.view` for isolated pages; `renderer.extension` for trusted code
  in the host document; `agent.extension` for trusted code in the Agent sidecar.
- `agent.tool.register` for runtime tool registration; `agent.prompt.inject` for
  skill catalogs/bodies; `agent.complete` for quota-spending one-shot completions.
- `models.list`, `usage.read`, `session.read`, and the separate ownership-scoped
  `session.import`, `session.read.own`, `session.update.own`, `session.delete.own`.
- `provider.register` for manifest providers, `provider.oauth` for OAuth callbacks,
  `composer.transform` for draft transformations, `composer.suggest` for one
  dismissible placeholder line; these do not implicitly grant transcript reads.
- `ui.theme` for CSS/runtime themes/typed variables; `ui.settings` plus `ui.theme`
  for data-only `scenicThemes`; `ui.window.appearance` for native appearance.
- `net.fetch` / `net.websocket` for host egress, and separately reviewed
  `net.anyHost` if user-entered endpoints cannot be declared beforehand.
- `keyboard.globalShortcut` for host-owned system shortcuts; local `shortcut`
  settings remain application-scoped.
- `desktop.control`, `browser.cdp`, `project.create`, and `session.autoTitle` for
  their separate reviewed host operations. Dangerous desktop operations need
  `confirm: true` plus the user's host-owned native confirmation.

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
  `net.domains` means no egress unless the user separately grants `net.anyHost`.
  That exception still refuses cloud metadata and grants no API permission itself.
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
durable task notification inbox. Clicking a delivered notification restores and
focuses the main window but does not activate a session.

Host API groups are `app`, `themes`, `plugin`, `commands`, `speech`, `composer`,
`ui`, `project`, `providers.oauth`, `workspace`, `desktop`, `audio`, `keyboard`,
`fs`, `agent`, `models`, `session`, `usage`, `services`, `bus`, `clipboard`,
`shell`, `browser`, `net`, and `events`. This is not the panel API or the renderer
API. There is no host archive, arbitrary process, or network-server API.
Skills, MCP servers, and providers are manifest-owned; themes additionally have
`pi.themes.upsert` / `remove` / `list` / `setVariables` runtime APIs.

## Tool, session, and async boundaries

Register tools in `onLoad` with the same descriptor as `contributes.agentTools`.
Tools are deferred behind `ToolSearch`. Plan/Goal hides and denies them by
default; opt in only read-only `action` values through `planSafeActions` on the
runtime registration. The runner checks `args.action` before execution. A low
risk label, session grant, or auto mode does not replace the allowlist.
Use the tool context's `signal`, `sessionId`, and `turnId`; cancel side work and
never replace the invoking session with whichever session is visible.

`pi.session.getActive()` and `session:activated` expose the selected session
snapshot without transcript access. Recheck session identity after an await.
`session:turnEnded` carries `{ sessionId, turnId, reason }`, once per settled
host turn to live listeners, without replay; late tools can still be running.
`pi.ui.revealView` needs `ui.view` and may reveal only your own declared view
for the session still on screen. Subscribe/unsubscribe with matching handlers.

`pi.session.getLlmContext()` and `includeSessionContext` completions need
`session.read` and an active invocation of this plugin's Agent tool. A service,
Composer callback, or selected-session snapshot does not grant this context.
`pi.models.list()` returns ready model keys without secrets. `pi.agent.complete`
uses the user's model, no tools, a 90s budget and eight calls per rolling minute.
Handle timeout/rate-limit/provider failures without infinite retries.

Imported sessions need declared `sessionSources`; operations are scoped to the
calling plugin. Historical project/model strings do not bind a live session;
use an explicit `projectId` with `project.create` when needed. Auto titles use
bounded first-turn context and compare-and-set `expectedTitle`; manual names win.

## Composer, providers, and real-time capabilities

`contributes.composerTransforms` invokes `onComposerTransform({ id, text,
modelKey? })` only after the user's action. Return a string (100,000-character
input/output cap). The host handles file-reference preservation, stale drafts,
session changes, and undo. No history or attachment payload is supplied.
`pi.composer.suggest({ sessionId, turnId?, text, ttlMs? })` needs
`composer.suggest`: one folded line, 200 characters, 120s default, 1..600s TTL.
It appears only for an empty visible Composer; Tab accepts, Esc dismisses. Normal
refusals are `{ shown: false, reason }`; it never sends a message. Prefer the
triggering turn-ended event's `turnId` to protect against late completions.

Providers are manifest-owned native rows. API-key providers can use Add Service;
empty models require `baseUrl` and discover after key save. OAuth needs both
provider grants and `onProviderOAuth(request, { signal })` for login/refresh.
Use host prompt/notify helpers; only this provider's refresh callback receives
its existing credential. Never log or copy it into settings or bus messages.

`pi.keyboard` registers at most eight own-command global shortcuts; inspect
`registered`/`error` instead of assuming a conflict throws. `pi.net.websocket`
provides four host-owned sockets, 1 MiB frames, 4 MiB queued sends, with per-socket
`net:websocket:*` events and unload cleanup. `ui.microphone` is panel audio only.
All ten background `pi.audio.*` methods exist but have no device backend:
authorized calls still return/throw `UNSUPPORTED`. Speech adapters use the
separate `speech.adapter.register` gate.

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
`dist` and credential files (`.env`, `.env.*`, `.npmrc`, `*.pem`, `*.key`) are
excluded automatically; the package must stay under 2000 files and 50 MB, and may
not contain symlinks.


`pi-plugin publish` in the repository CLI prepares a local `.submission.json`
and `.piplug`; it does not upload. Ignore `dist/` before its clean-worktree check.
Publish through the official plugin center (`plugins.aiuo.net`); the distribution
mirror does not host plugin source. Full author guide: `docs/plugin-development.md`
and its Chinese mirror. Do not treat draft pages under `docs/plugin-plan` as
implemented SDK exports.
