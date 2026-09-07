# 03. Plugin API

## 1. Design principles

1. Small and stable
2. Permission-driven
3. Async-first
4. Auditable
5. Do not expose host internal objects

## 2. Runtime-injected object

Inside the plugin runtime, a global is available:

```ts
declare const pi: PiPluginHostApi;
```

## 3. API overview (MVP)

### app
```ts
pi.app.getVersion(): Promise<string>
pi.app.getLocale(): Promise<string>
pi.app.getAppearance(): Promise<PluginAppearance>
```

`app.getAppearance` returns the appearance the host is currently showing so a
plugin (or its panel) can mirror the app's language and color mode exactly:

```ts
type PluginAppearance = {
  theme: string        // raw preference: "light" | "dark" | "system" | "plugin:<pluginId>:<themeId>"
  base: "light" | "dark" | "system"  // palette the preference resolves to
  locale: string       // active language tag (e.g. "en", "zh-CN")
  pluginTheme: { id: string; base: "light" | "dark"; css: string } | null
}
```

Panels read the same value through the bridge channel `app.getAppearance` and
receive live updates on the `appearance:changed` event (below). On hosts older
than the channel, the call rejects with `UNSUPPORTED`; panels should fall back
to the OS preference and their own in-panel choice.

### plugin
```ts
pi.plugin.getId(): string
pi.plugin.getManifest(): PluginManifestV1
pi.plugin.getSettings<T=Record<string, unknown>>(): Promise<T>
pi.plugin.setSettings(partial: Record<string, unknown>): Promise<void>
pi.plugin.getDataPath(): Promise<string> // plugin-private directory
```

The installed Plugins page renders every `contributes.settings` field and
persists edits in the plugin's private settings file. Supported generated
controls are `string`, `number`, `boolean`, `select`, `json`, and `shortcut`.
Shortcut settings are plugin-local: they invoke the declared `command` only
while the PI-Desktop app window is focused and while the plugin's activation
scope matches the current project. They are never registered as OS-global
shortcuts in this release. The host emits `plugin:settingsChanged` after a
user edit so a plugin can refresh in-memory configuration.

### commands
```ts
pi.commands.register(def: {
 id: string
 title: string
 keywords?: string[]
 run: () => Promise<void> | void
}): Promise<void>

pi.commands.unregister(id: string): Promise<void>
```

### ui
```ts
pi.ui.openPanel(options?: { title?: string }): Promise<void>
pi.ui.closePanel(): Promise<void>
pi.ui.showToast(message: string, level?: "info"|"warn"|"error"): Promise<void>
pi.ui.notify(input: { title: string; body?: string }): Promise<void>
pi.ui.getNotificationPermission(): Promise<PluginNotificationPermission>
pi.ui.requestNotificationPermission(): Promise<PluginNotificationPermission>
pi.ui.showNativeNotification(input: {
  title: string
  body?: string
}): Promise<{ shown: boolean; permission: PluginNotificationPermission }>

type PluginNotificationPermission = "granted" | "denied" | "unknown" | "unsupported"
```

`ui.notify` remains an in-app Toast. Native delivery is opt-in through
`ui.showNativeNotification` and is guarded by the same manifest `notify`
permission. `requestNotificationPermission` performs the platform-native
permission probe by showing a short confirmation notification; Electron does
not expose a cross-platform read-only notification permission API, so
`unknown` is returned before the first probe and when the operating system does
not report a result. Native delivery is best-effort: an OS policy may suppress
the banner without changing the durable task notification inbox.

### workspace / fs
```ts
pi.workspace.get(): Promise<{ path: string; name: string } | null>

pi.fs.readText(pathFromRoot: string): Promise<string>
pi.fs.readPreview(pathFromRoot: string): Promise<{
  kind: "text" | "image" | "binary" | "tooLarge"
  content?: string     // UTF-8 when kind is "text"
  dataUrl?: string     // data URL when kind is "image"
  size: number
}>
pi.fs.openDefault(pathFromRoot: string): Promise<void>
pi.fs.reveal(pathFromRoot: string): Promise<void>
pi.fs.writeText(pathFromRoot: string, content: string): Promise<void>
pi.fs.glob(pattern: string): Promise<string[]>
pi.fs.list(pathFromRoot: string): Promise<Array<{
  name: string;
  path: string;        // root-relative, usable directly with readText / list
  isDirectory: boolean;
  size?: number;       // files only
}>>
pi.fs.remove(pathFromRoot: string): Promise<void>
pi.fs.requestDirectory(): Promise<{ path: string; name: string } | null>
```

`fs.readPreview` classifies one existing readable file for in-app display. It
uses the same `fs.read` checks as `fs.readText`, rejects directories, and
returns `text` (capped at 512 KiB), `image` (capped at 5 MiB, as a data URL),
`binary`, or `tooLarge`. The plugin never receives an absolute path.

`fs.openDefault` opens one existing file with the operating system's default
associated application. It uses the same `fs.read` root, symlink, protected-path,
deny-list, and scope checks as `fs.readText`; directories are rejected. The
host audits the operation and never accepts an absolute path from the plugin.

`fs.reveal` reveals one existing readable file in the operating system's file
manager and selects it when the platform supports that behavior. It uses the
same `fs.read` checks, rejects directories, and audits both success and failure.
The plugin receives and supplies only the root-relative path.

Paths are relative to the mode's root — the workspace, or the directory the user
picked through `requestDirectory()` when the mode declares
`root: "userSelected"`. Which paths each mode may reach comes from `manifest.fs`;
anything outside it prompts the user, and the credential deny-list overrides both
(see [04-plugin-security.md](04-plugin-security.md) §6). `remove` is
non-recursive and moves the path to the OS trash.

`list` returns one directory's entries, name-sorted, so a plugin can walk a tree
lazily instead of pulling a whole-repo `glob` and reassembling it. It applies the
same guards as `glob`, because a listing is a read: files outside the declared
read scope are omitted, denied names and protected paths are omitted, and heavy
directories (`node_modules` and friends) are skipped. Directories are always
returned so a narrow scope still yields a navigable tree, and at most 1000
entries come back per call.

### agent
```ts
pi.agent.registerTool(tool: {
 name: string
 description: string
 risk: "low"|"medium"|"high"
 schema: unknown
 execute: (args: unknown, ctx: ToolExecContext) => Promise<unknown>
}): Promise<void>

pi.agent.unregisterTool(name: string): Promise<void>
```

Registered plugin agent tools are Agent-only contributions. During Plan the
host filters them out of the model tool list and rejects direct execution with
`PLUGIN_DISABLED_IN_PLAN`, including when the manifest risk is `low`, the user
has an `allow-session` grant, or the session permission mode is `auto`. A
successful plan approval makes the same registered tools eligible again under
the selected Agent permission policy.

```ts
type ToolExecContext = {
 sessionId: string
 turnId?: string
 signal?: AbortSignal
 log: (msg: string) => void
}
```

### clipboard / shell
```ts
pi.clipboard.readText(): Promise<string>
pi.clipboard.writeText(text: string): Promise<void>
pi.clipboard.getHistory(): Promise<ClipboardHistoryEntry[]>

type ClipboardHistoryEntry =
  | { type: "text"; text: string; capturedAt: string }
  | {
      type: "image"
      format: "png" | "jpeg" | "webp"
      data: Uint8Array
      width: number
      height: number
      capturedAt: string
    }
pi.shell.openExternal(url: string): Promise<void>
```

`openExternal` parses `url` and opens only `http:`, `https:`, and `mailto:`
hrefs (D330 / ADR 0168). Other schemes fail with `INVALID_ARGUMENT`.

### browser (requires `browser.cdp`)
```ts
pi.browser.navigate(input: { url?: string; path?: string }): Promise<BrowserState | null>
pi.browser.action(input: { action: "back" | "forward" | "reload" | "stop" }): Promise<void>
pi.browser.setBounds(hole: { x: number; y: number; width: number; height: number }): Promise<unknown>
pi.browser.setVisible(visible: boolean | { visible: boolean }): Promise<void>
pi.browser.getState(): Promise<BrowserState | null>
pi.browser.openExternal(): Promise<void>
pi.browser.snapshot(): Promise<{ tree: string; url: string; title: string }>
pi.browser.screenshot(input?: { fullPage?: boolean }): Promise<{ mimeType: string; data: string; path?: string }>
pi.browser.click(input: { uid: string }): Promise<void>
pi.browser.fill(input: { uid: string; text: string }): Promise<void>
pi.browser.evaluate(input: { expression: string }): Promise<unknown>
pi.browser.console(input?: { limit?: number }): Promise<{ messages: unknown[] }>
pi.browser.cdp(input: { method: string; params?: unknown }): Promise<unknown>
```

The guest page is a host-owned `WebContentsView` (`persist:work-browser`).
`setBounds` is content-relative to the calling plugin view and is clamped so
the guest cannot cover chat/composer. `cdp` is deny-by-default; cookie,
storage, target, and network-interception methods fail with
`PERMISSION_DENIED`. Session identity for agent calls comes from the in-flight
`plugins.execute` `sessionId`, not from plugin arguments (D333 / ADR 0170).

`getHistory` returns newest-first entries captured by the host while the app is
running, with text and images interleaved in capture order. The first clipboard
sample after startup establishes a baseline and is not added; content written
through `writeText` is captured immediately. Consecutive identical content is
collapsed and refreshes its timestamp. History is in-memory only and is
bounded to 30 days, 500 entries, and 256 MiB total payload; individual entries
are limited to 100 KiB of UTF-8 text or 50 MiB of image bytes. Images are
returned as PNG bytes with their pixel dimensions, regardless of the source OS
clipboard representation. The host samples for changes because Electron has
no cross-platform clipboard-changed event.

### services (requires `background.service`)
```ts
pi.services.register(service: {
 id: string // must match a contributes.services[].id
 start: (ctx: { log: (msg: string) => void }) => Promise<void> | void
 stop?: () => Promise<void> | void
}): void

pi.services.unregister(id: string): Promise<void>
```

Registration is local bookkeeping: it records the handlers so the broker can
call them. The host calls `start` after `onLoad` and `stop` before unload, and
restarts a crashed plugin per [05-plugin-lifecycle.md](05-plugin-lifecycle.md).
`start` is idempotent within one process — a second start on an already-running
service is a no-op.

### bus (requires `bus.publish` / `bus.subscribe`)
```ts
pi.bus.publish(topic: string, payload?: unknown): Promise<void>
pi.bus.subscribe(
 pattern: string,
 handler: (message: PluginBusMessage) => void,
): Promise<() => Promise<void>> // resolves to unsubscribe
```

```ts
type PluginBusMessage = {
 topic: string
 from: string // publisher plugin id
 payload?: unknown
 at: string // ISO timestamp assigned by the host
}
```

`topic` must appear in `contributes.bus.publish`; `pattern` must appear in
`contributes.bus.subscribe`. A publisher is excluded from its own fan-out. Caps
and the threat model are in [04-plugin-security.md](04-plugin-security.md) §5.1.

### net
```ts
pi.net.fetch(input: {
 url: string
 method?: string
 headers?: Record<string, string>
 body?: string
 timeoutMs?: number
}): Promise<{ status: number; headers: Record<string, string>; bodyText: string }>
```

## 4. Error model

```ts
type PluginApiError = {
 code:
 | "PERMISSION_DENIED"
 | "NOT_FOUND"
 | "INVALID_ARGUMENT"
 | "TIMEOUT"
 | "UNSUPPORTED"
 | "LIMIT_EXCEEDED" // a per-plugin cap is full (e.g. bus subscriptions)
 | "RATE_LIMITED" // a rolling window is exhausted (e.g. bus publishes)
 | "INTERNAL"
 message: string
}
```

All API failures throw an error carrying a `code`.

## 5. Events (host -> plugin)

```ts
pi.events.on(event, handler)
pi.events.off(event, handler)
```

The host pushes events to the plugin process as one-way frames. Delivered today:

- `bus.message` — a bus delivery, with the `PluginBusMessage` as the single
  argument. `pi.bus.subscribe` is the normal way to receive these; `events.on`
  sees the raw stream of every subscription the plugin holds.
- `workspace:changed` — payload is `{ path: string; name: string } | null`,
  matching `workspace.get()`, sent when the cached workspace path changes.
- `plugin:settingsChanged` is delivered after edits from the generated Plugins
  settings UI.

A throwing handler is logged and does not affect other listeners or the plugin.

Planned events:
- `session:activated`
- `app:themeChanged` — for now, panels follow the palette live through the
  panel event `appearance:changed`; the plugin-process event remains planned.

## 6. Panel bridge API

The Panel UI does not get the full `pi` directly; instead:

```ts
window.pluginBridge.invoke(channel, payload?)
window.pluginBridge.on(event, handler)
```

The same bridge serves both plugin surfaces: a detached `ui.panel` window and a
`contributes.views` surface docked in the work panel (ADR 0104). The channel
list, the permission gate, and the preload are identical, so one HTML entry
works in either placement. The only difference is chrome: a docked view has no
window-control capsule and no drag band, and its
`--pi-plugin-titlebar-height` is `0px` rather than `46px`.

Detached panel pages using the current chrome contract declare
`<meta name="pi-plugin-chrome" content="v2">` and use the published variable
for normal-flow top spacing. The host preserves that page-owned spacing. A
page without the marker remains supported through the legacy additive offset.

The host-owned preload forwards only fixed channels to the plugin runtime:

| Channel | Required permission |
|---|---|
| `ui.showToast`, `ui.closePanel` | None beyond the loaded panel |
| `ui.notify` | `notify` |
| `ui.getNotificationPermission`, `ui.requestNotificationPermission`, `ui.showNativeNotification` | `notify` |
| `plugin.getSettings`, `workspace.get`, `app.getAppearance` | None |
| `fs.readText`, `fs.readPreview`, `fs.openDefault`, `fs.reveal`, `fs.glob`, `fs.list` | `fs.read` |
| `fs.writeText` | `fs.write` |
| `clipboard.readText`, `clipboard.getHistory` | `clipboard.read` |
| `clipboard.writeText` | `clipboard.write` |
| `shell.openExternal` | `shell.openExternal` |
| `net.fetch` | `net.fetch` |

`plugin.setSettings`, `fs.remove`, and arbitrary Electron IPC are not exposed. A
channel the host does not implement itself is forwarded to the plugin's
`onPanelInvoke(channel, payload)`, so a plugin may define its own panel ↔ main
channels; a plugin that exports no `onPanelInvoke` gets `UNSUPPORTED` from its own
process. The host-supported channels include `skill.list`, `skill.read`,
`skill.create`, `skill.update`, `skill.remove`, and `skill.setEnabled`.

### Panel events (host -> panel)

`window.pluginBridge.on(event, handler)` receives host-pushed events. The host
sends the same events to detached panel windows and to docked work-panel views.
Delivered today:

- `appearance:changed` — payload is the `PluginAppearance` above, sent whenever
  the app's palette or language changes, so a panel can restyle and relabel live.
- `workspace:changed` — payload is `{ path: string; name: string } | null`,
  matching `workspace.get()`, sent when the open project changes.

## 7. Call auditing

Any of the following calls must be logged for audit:

- fs.writeText
- fs.remove, fs.requestDirectory, and every refused fs call (with its path and
  `errorCode`), plus each consent answer and why it was asked (`scope` / `rate`)
- fs.openDefault (with its root-relative path and whether the OS open succeeded)
- fs.reveal (with its root-relative path and whether the file manager reveal succeeded)
- fs.readPreview (with its root-relative path and classified `kind`)
- execute after agent.registerTool (including tools discovered from a plugin's
  MCP servers)
- net.fetch
- shell.openExternal
- clipboard.read/write (may be sampled)
- clipboard.getHistory (with the returned entry count)
- bus.publish / bus.subscribe / bus.unsubscribe (with the topic and fan-out size)
- browser.navigate / evaluate / cdp / openExternal
- service start / stop / restart

Log fields:
- pluginId
- api
- ts
- sessionId?
- ok / errorCode

## 8. Versioning strategy

- The API surface is managed by `apiVersion`
- MVP `apiVersion = 1`
- A deprecated API is retained for at least one major version cycle


## 9. Implementation status

The desktop plugin runtime now implements the MVP host API surface used by local and marketplace plugins:

- `app.*`, `plugin.*`, `commands.*`, `ui.*`, `workspace.*`
- `fs.readText` / `fs.readPreview` / `fs.openDefault` / `fs.reveal` /
  `fs.writeText` / `fs.glob` / `fs.list` / `fs.remove` / `fs.requestDirectory`,
  bounded by `manifest.fs` (ADR 0088)
- `agent.registerTool` / `unregisterTool`
- `clipboard.*`, `shell.openExternal`, `net.fetch`
- `browser.*` (guest CDP; `browser.cdp`)
- `services.register` / `unregister`, `bus.publish` / `subscribe`, `events.on` / `off`

Native plugin notifications use the Electron main-process notification surface;
they do not create durable rows in the task notification inbox and do not
activate a session on click.

Declarative contributions have no `pi.*` counterpart on purpose: skills, themes,
and MCP servers are read from the manifest by the host, so a plugin cannot add
one at runtime.

All high-risk entry points assert declared+granted permissions and emit audit log lines.
Plugin panels no longer receive the full `pi` object; they use `window.pluginBridge.invoke`.
