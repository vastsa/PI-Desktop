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

> Status legend: every section below is **shipped** and enforced by
> `PluginRuntime` unless its heading or text says **Planned**. A planned
> surface is documented ahead of implementation so plugin authors can see the
> direction; it throws `UNSUPPORTED` until it lands (see §9 for the
> per-surface list).

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

### project (requires `project.create`)

```ts
pi.project.create(input: { path: string }): Promise<{
  projectId: number
  path: string
  name: string
}>
```

This creates or reuses a durable host project record without changing the
active workspace. The returned `projectId` may be passed explicitly to
`pi.session.import()` or an item in `pi.session.importBatch()`. The plugin must
hold `project.create` when it supplies a project id. Omitting `projectId` keeps
the imported session unbound; `projectPath` remains historical source metadata
and never creates a project by itself.

### workspace / fs
```ts
pi.workspace.get(): Promise<{ path: string; name: string } | null>

pi.fs.readText(pathFromRoot: string): Promise<string>
pi.fs.stat(pathFromRoot: string, grantId?: string): Promise<{
  size: number;
  mtimeMs: number;
}>
pi.fs.readRange(
  pathFromRoot: string,
  byteOffset: number,
  length: number,
  grantId?: string,
): Promise<{ bytes: Uint8Array; totalSize: number }>
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
  mtimeMs?: number;    // files only; Unix epoch milliseconds
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

`fs.stat` returns the size and modification time of one existing readable file
without loading its contents. `fs.readRange` returns at most 8 MiB of bytes and
the total file size. Both use the same root, symlink, protected-path, deny-list,
scope, consent, and audit gates as `fs.readText`; offsets and lengths are
non-negative safe integers. An offset at or beyond EOF returns an empty byte
array. A `grantId` is only valid for a host-issued dropped-file grant and then
requires the matching absolute path.

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
 /** Executor model for this session, `providerId/modelId`. Configuration, not transcript. */
 modelKey?: string
 thinkingLevel?: ThinkingLevel
 signal?: AbortSignal
 log: (msg: string) => void
}
```

### models (requires `models.list`)
```ts
pi.models.list(): Promise<PluginModelInfo[]>

type PluginModelInfo = {
  key: string                 // `${providerId}/${modelId}` — first slash splits
  providerId: string
  providerName: string
  modelId: string
  label: string
  supportsReasoning: boolean
  thinkingLevels: ThinkingLevel[]
}
```

Only enabled, authenticated provider rows are returned (API key, OAuth, or
`authKind: "none"`). No secrets. `models.list` is also a panel-bridge channel
so a picker page can populate itself. When the host transport is unavailable,
the call returns an empty list instead of warning (D080).

### session (requires `session.read`)
```ts
pi.session.getLlmContext(): Promise<PluginLlmContext>

type PluginLlmMessage = {
  role: "user" | "assistant" | "tool" | "system"
  content: string
  toolName?: string
}

type PluginLlmContext = {
  sessionId: string
  modelKey: string | null
  thinkingLevel?: ThinkingLevel
  messages: PluginLlmMessage[]
  truncated: boolean
}
```

The plugin cannot pass a session id. Identity is the in-flight `plugins.execute`
session (D333 / D336). Calling this outside a tool execution fails with
`INVALID_ARGUMENT`. Subagent rows are omitted. An in-flight call of the
plugin's own tool is stripped from the tail. A compaction summary replaces
pre-checkpoint history. Combined content is capped at 200k characters.

### plugin-owned sessions (P0/P1; requires the matching permission)

Plugins may import and manage only sessions whose origin belongs to that same
plugin. The source must be declared in `manifest.contributes.sessionSources`;
the host supplies the localized source label and generates the durable session
and message ids. Imported sessions never bind a workspace, provider, or model;
they bind a project only when the caller supplies an existing `projectId`. The
original import values remain available in `get().history`.

```ts
type PluginSessionSourceContrib = {
  id: string
  label?: string | { en: string; "zh-CN": string }
}

pi.session.import(input: {
  source: string
  externalId: string
  title: string
  projectId?: number | null // explicit id from pi.project.create; omitted is unbound
  projectPath?: string | null
  modelId?: string | null
  providerId?: string | null
  createdAt: string // strict RFC3339
  updatedAt: string // >= createdAt
  messages: Array<{
    role: "user" | "assistant" | "tool"
    content: string
    createdAt: string // monotonic within the session
    modelId?: string
    providerId?: string
    toolName?: string
    toolCallId?: string
    toolStatus?: "success" | "error"
    toolArgs?: unknown
    toolResult?: unknown
  }>
}): Promise<{ sessionId: string; imported: boolean; skipped: boolean }>

pi.session.importBatch(input: {
  source: string
  sessions: Array<Omit<PluginSessionImportInput, "source">>
  mode?: "skip" | "fail"
}): Promise<PluginSessionBatchImportResult>

pi.session.list(input?: {
  limit?: number; cursor?: string; source?: string; updatedAfter?: string
}): Promise<PluginSessionListResult>
pi.session.get(input: { sessionId: string }): Promise<PluginSessionGetResult>
pi.session.listMessages(input: {
  sessionId: string; limit?: number; cursor?: string
  order?: "asc" | "desc"; contentLimit?: number
}): Promise<PluginSessionMessageListResult>
pi.session.rename(input: { sessionId: string; title: string }): Promise<{ updated: boolean }>
pi.session.delete(input: {
  sessionId: string; mode?: "trash" | "purge"
}): Promise<{ deleted: boolean }>
```

Import is idempotent on `(pluginId, source, externalId)`. `skip` batches
continue per item; `fail` batches validate and commit atomically. `trash` hides
the session while retaining its transcript and origin; `purge` removes both and
allows a later re-import. Reads, rename, and delete are ownership-scoped, and
undeclared sources fail with `PERMISSION_DENIED`.

When a session has an explicit project binding, `projectId` and
`bound.workspace` report that binding, and `get().projectPath` resolves the
bound project's current path. The original import `projectPath` remains in
`get().history`.

After a successful import, rename, or delete, Electron main emits one
host-owned `sessionsChanged` event for the affected mutation. The renderer
refreshes its authoritative session list and the Projects page refreshes its
durable project index from that list. Plugins do not emit or coordinate this
event themselves. A project created through this API is not automatically
opened as a sidebar tab, preserving the existing closed-project behavior.

The host enforces a 2,000-message/session, 100-session/batch, 512 KiB/message,
256 KiB/tool-value, 32 MiB/payload, and JSON-depth-8 limit. Import is limited
to 10 calls/minute plus 5 batch calls/minute per plugin; delete is limited to
20 calls/minute. Tool `__pi*` and `piDesktop.*` object keys are removed before
storage. P2/P3 operations (session create, message mutation, arbitrary re-binding,
provider/model binding, batch delete, and tags) are intentionally not part of
this contract.

### agent.complete (requires `agent.complete`)
```ts
pi.agent.complete(input: {
  modelKey: string
  thinkingLevel?: ThinkingLevel
  system?: string
  messages?: Array<{ role: "user" | "assistant"; content: string }>
  includeSessionContext?: boolean
}): Promise<{
  text: string
  modelKey: string
  thinkingLevel?: ThinkingLevel
  usage?: MessageUsage
}>
```

The host resolves credentials and runs a one-shot completion with `tools: []`
through the same path as Composer prompt enhancement. The plugin never receives
a secret. `includeSessionContext: true` also requires `session.read` and an
in-flight tool session; the host serializes that context and, if `messages` is
empty, appends `Please respond to the request.` System prompt
≤ 32 KiB; combined messages ≤ 200k characters; eight calls per plugin per
rolling 60s (`RATE_LIMITED`); 90s budget (`TIMEOUT`). Empty model output is
`INVALID_ARGUMENT`.

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

`getHistory` returns newest-first entries explicitly recorded by the host, with
text and images interleaved in capture order. Content written through
`writeText` and content supplied by the Composer's user-initiated `paste` event
are recorded; the host does not poll or reread the OS clipboard in the
background. Consecutive identical content is collapsed and refreshes its
timestamp. History is in-memory only and is bounded to 30 days, 500 entries,
and 256 MiB total payload; individual entries are limited to 100 KiB of UTF-8
text or 50 MiB of image bytes. Images are returned as PNG bytes with their
pixel dimensions. A copy that is never pasted is intentionally not captured.

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

### desktop control (requires `desktop.control`)

```ts
pi.desktop.listOperations(): Promise<Array<{
  id: string
  description: string
  risk: "read" | "write" | "dangerous"
}>>

pi.desktop.invoke(input: {
  operation: string
  args?: unknown[]
  confirm?: boolean
}): Promise<unknown>
```

This is the first-party plugin gateway to the same reviewed operation catalog
used by the opt-in local MCP control plane (ADR 0203 / D370). The returned
catalog omits Electron channel names and the plugin never receives the MCP
bearer token. Invocation reuses the controller, IPC handler, lifecycle checks,
completion event, and audit boundary; a plugin cannot reach arbitrary Electron
IPC.

A `dangerous` operation (session delete, permission-mode change, tool
approval) needs two answers. `confirm: true` is the plugin's acknowledgement
and is required first (`CONFIRMATION_REQUIRED` otherwise). The host then asks
the user in a native dialog that names the catalog operation id, its catalog
description, and an argument preview; the dialog never shows plugin- or
model-authored text, so a prompt-injected transcript cannot relabel
`session/delete` as something benign. A dismissed dialog, a declined dialog,
or a host without a dialog service all fail with `PERMISSION_DENIED` before
the controller is reached. Calls are logged with the plugin id, operation,
risk, and result status; argument values are not copied into the audit entry.

### microphone panels (requires `ui.microphone`)

An isolated panel may request microphone audio through the browser media API
only when the manifest declares and the user grants `ui.microphone`:

```ts
navigator.mediaDevices.getUserMedia({ audio: true })
```

The host permission handler allows the `media` permission for that panel and
continues to deny camera and every other device permission. The plugin does
not receive a native microphone handle or a host secret; browser speech
recognition and speech synthesis remain page-owned. A panel should provide a
text fallback and announce permission or recognition failures through its
accessible status.

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
 | "CONFIRMATION_REQUIRED" // a dangerous desktop operation without confirm: true
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

The host pushes events to the plugin process as one-way frames. `pi.events`
is not a separate channel: it is an alias over the same per-plugin bus stream
that `pi.bus.subscribe` consumes (`plugin-host-process.mjs`), so an `on`
handler sees every frame the host delivers to this plugin and nothing else.
Delivered today:

- `bus.message` — a bus delivery, with the `PluginBusMessage` as the single
  argument. `pi.bus.subscribe` is the normal way to receive these; `events.on`
  sees the raw stream of every subscription the plugin holds.
- `workspace:changed` — payload is `{ path: string; name: string } | null`,
  matching `workspace.get()`, sent when the cached workspace path changes.
- `plugin:settingsChanged` is delivered after edits from the generated Plugins
  settings UI.
- `session:modelChanged` — `{ sessionId, modelKey, thinkingLevel }`, sent after
  a successful `session.configure` that changes provider, model, or thinking
  level.

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
| `models.list` | `models.list` |
| `fs.readText`, `fs.stat`, `fs.readRange`, `fs.readPreview`, `fs.openDefault`, `fs.reveal`, `fs.glob`, `fs.list` | `fs.read` |
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
- fs.stat, fs.readRange, fs.remove, fs.requestDirectory, and every refused fs call (with its path and
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
- models.list (returned row count)
- session.getLlmContext (session id, message count, truncated flag — never transcript text)
- agent.complete (model key, sizes, usage — never prompt or completion text)

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
- `fs.readText` / `fs.stat` / `fs.readRange` / `fs.readPreview` / `fs.openDefault` / `fs.reveal` /
  `fs.writeText` / `fs.glob` / `fs.list` / `fs.remove` / `fs.requestDirectory`,
  bounded by `manifest.fs` (ADR 0088)
- `agent.registerTool` / `unregisterTool` / `agent.complete`
- `models.list`, `session.getLlmContext`
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
