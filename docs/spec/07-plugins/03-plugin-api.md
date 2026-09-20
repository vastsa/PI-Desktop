# 03. Plugin API

## Theme variables

`pi.themes.setVariables(themeId, values)` requires `ui.theme`. The host accepts
only values for declared variables on one of the caller's themes, persists them
in private plugin settings, and refreshes an active theme without selecting a
new theme or reloading the renderer. It never accepts stylesheet text, URLs,
selectors, images, fonts, or arbitrary property names.

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
pi.app.setTheme(themeId: "system" | "light" | "dark" | `plugin:${string}`): Promise<void>
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
receive live updates on the `appearance:changed` event (below). Plugin processes
receive the same event on `pi.events`. On hosts older than the channel, the call
rejects with `UNSUPPORTED`; panels should fall back to the OS preference and
their own in-panel choice.

`app.getLocale` is the same language tag as `getAppearance().locale`. Plugin-owned
UI (panels, views, widgets, settings destinations, toasts, runtime command titles)
localizes from this value. The host does not grow `{ en, "zh-CN" }` maps on more
contribution fields; generated `contributes.settings` titles stay plain strings
(ADR 0280). Host-owned identity (`manifest.i18n`) and already-shipped chrome
labels (`ui.title`, view titles, destinations) keep their existing contracts
(ADR 0267, ADR 0082).

`app.setTheme` (requires `ui.theme`, ADR 0260) applies the app theme
preference the Settings picker writes. It accepts a built-in preference or a
currently registered plugin theme id; unknown ids reject with
`INVALID_ARGUMENT`. The host persists `AppSettings.theme`, refreshes native
chrome / panel appearance, and emits `settingsChanged` to the renderer.

### themes (requires `ui.theme`)

Runtime registry for the calling plugin's own themes. Works in production
without unload/reload (ADR 0260).

```ts
pi.themes.upsert(input: {
  id: string;           // local id, same rules as contributes.themes[].id
  label: string;
  base: "light" | "dark";
  css: string;          // sanitized with sanitizeThemeCss
}): Promise<void>

pi.themes.remove(themeId: string): Promise<void>
pi.themes.list(): Promise<Array<{ id: string; themeId: string; label: string; base: "light" | "dark" }>>
```

- Full ids are namespaced `plugin:<pluginId>:<themeId>`.
- `upsert` of an existing id replaces label / base / css.
- There is no per-plugin theme count cap; the CSS size cap and sanitizer still apply.
- After upsert/remove the host emits `pluginChanged` (`reason: "themes"`) and
  refreshes panel appearance, so an updated **active** theme restyles immediately.

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
Generated `title` / `description` / `enum[].label` are author-language strings;
the host does not resolve locale maps on them. A plugin that needs a localized
settings surface ships `settingsDestinations` and reads `pi.app.getLocale`
(ADR 0280). Shortcut settings are plugin-local: they invoke the declared
`command` only while the PI-Desktop app window is focused and while the plugin's
activation scope matches the current project. They are never registered as
OS-global shortcuts in this release. The host emits `plugin:settingsChanged`
after a user edit so a plugin can refresh in-memory configuration.

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

### speech (`speech.adapter.register`)
```ts
pi.speech.registerAdapter(adapter: {
  protocol: string
  label: string
  roles: Array<"transcribe" | "synthesize">
  handle: (input) => Promise<{ kind: "text"; text: string } | { kind: "audio"; mimeType: string; data: string } | { kind: "http"; call: SpeechHttpCall }>
}): Promise<void>
pi.speech.unregisterAdapter(protocol: string): Promise<void>
```

The handle stays in the plugin process. Built-in protocol ids `openai_audio`
and `openai_chat_audio` are reserved. HTTP plans are executed by the host with
the bound provider key and must stay on that origin.

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
the banner without changing the durable task notification inbox. Clicking a
delivered plugin notification restores and focuses the main window, but never
activates a session or creates a durable task notification.

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
pi.workspace.get(): Promise<{
  path: string;
  name: string;
  projectId?: string;
  roots?: Array<{ path: string; name: string; primary: boolean }>;
} | null>

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

`workspace.get` answers with the primary root — `path` and its leaf `name`,
both unchanged — plus, when that folder belongs to a project group (ADR 0249),
`projectId` and `roots`: every registered folder of the group in its own order,
primary first, each `{ path, name, primary }` (ADR 0263). `workspace:changed`
carries the same object, and main answers both from the host-owned group
records, so the event and the pull cannot disagree. A host that cannot resolve
the group omits `projectId` and `roots` — the same `{ path, name }` a plugin
already handles — and reading this metadata needs no new permission and adds no
SDK method.

`fs.readPreview` classifies one existing readable file for in-app display. It
uses the same `fs.read` checks as `fs.readText`, rejects directories, and
returns `text` (capped at 512 KiB), `image` (capped at 5 MiB, as a data URL),
`binary`, or `tooLarge`. The plugin never receives an absolute path.

`fs.openDefault` opens one existing file with the operating system's default
associated application. It uses the same `fs.read` root, symlink, protected-path,
deny-list, and scope checks as `fs.readText`; directories are rejected. The host
audits the operation. A path is root-relative by default, and an absolute path is
accepted only by this action and `fs.reveal` (no other mode takes one) when it lies
inside a registered folder root of the open project — which then becomes the
containment base for the request (ADR 0249 §5, ADR 0264). That is the shape a view
uses to name a file in a project folder other than the primary one.

`fs.reveal` reveals one existing readable file in the operating system's file
manager and selects it when the platform supports that behavior. It uses the
same `fs.read` checks, rejects directories, and audits both success and failure.
It takes a path exactly as `fs.openDefault` does: root-relative by default, and
absolute when the file lies inside another registered folder root of the open
project (ADR 0264).

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
Under the `workspace` root, paths are relative to the project of the tool session
that invoked the call, falling back to the visible workspace for a panel call,
which has no tool session (ADR 0266).

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

`turnId` is populated for host-driven turns and matches the `turnId` of the
corresponding `session:turnEnded` event (§5).

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

### usage (requires `usage.read`)

Read-only completed-turn facts for the non-deleted sessions the user can
still see. The host serves one flat fact row per turn — counters and
identifiers only; no message body, no transcript projection, and no write
path. Deliberately **no dashboard shape**: streaks, heatmaps, per-model
shares, and top-session rankings are the plugin's own computation on top of
these rows, so changing a metric definition later is never a breaking SDK
change.

```ts
pi.usage.listTurns(input?: {
  fromMs?: number      // inclusive window start, epoch ms; default toMs - 30 days
  toMs?: number        // inclusive window end, epoch ms; default now
  projectId?: number | null
  sessionId?: string
  cursor?: string      // opaque page cursor from the previous nextCursor
  limit?: number       // 1..=500 rows; default 200
}): Promise<{
  turns: Array<{
    turnId: string; sessionId: string; sessionTitle: string | null
    projectId: number | null; providerId: string | null; modelId: string | null
    startedAt: number; endedAt: number
    inputTokens: number; outputTokens: number
    cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number
  }>
  nextCursor: string | null
}>
```

Semantics:

- Only completed turns of non-deleted sessions are listed. A session the
  user deleted leaves the listing.
- Rows are ordered by `endedAt` ascending with a keyset cursor, so paging is
  stable while the window fills; the ranking a dashboard shows is its own
  sort, not the host's.
- The window spans at most 365 days; `limit` is 1..=500 (default 200). The
  Electron side validates first, and the host RPC re-checks the same bounds.
  Absent and `null` bounds are equivalent; an empty session title is returned
  as `null`.
- A missing or malformed `usage_json` yields zero cache/reasoning counters —
  never a partial row.

### session collaboration (requires `desktop.control`)

The official Session Orchestrator composes the reviewed desktop-control
catalog; this is not a second session API and it does not expose Electron
channels or the local MCP bearer token.

```ts
type SessionCollaborationOperation =
  | "session/collaboration/spawn"
  | "session/collaboration/send"
  | "session/collaboration/list"
  | "session/collaboration/status"
  | "session/collaboration/result"
  | "session/collaboration/cancel"

// All calls use pi.desktop.invoke({ operation, args: [input] }).
type SpawnInput = {
  task: string
  title?: string
  modelKey?: string
  notifyOnCompletion?: boolean
  idempotencyKey?: string
}
type SendInput = {
  sessionId: string
  content: string
  kind?: "task" | "message"
  notifyOnCompletion?: boolean
  idempotencyKey?: string
}
type ListInput = {}
type StatusInput = { sessionId: string }
type ResultInput = { sessionId: string; messageId?: string; turnId?: string }
type CancelInput = { sessionId: string; messageId?: string }
```

`spawn` returns a real durable target `sessionId` and host delivery
`messageId`. `send` addresses an existing Session ID in either direction and
reuses that session's project, model, context, and permission configuration;
`messageId` identifies one delivery and is never a worker identity. `status`
and `result` are bounded projections and do not load a full transcript.
`cancel` interrupts only the exact queued delivery or bound turn and retains
the target session and history.

A named `spawn` `modelKey` is an AI-driven delegation choice and needs that
model's own `ModelBinding.availableForSubagents` opt-in; the host answers
`PERMISSION_DENIED` for a model the user has not enabled, before creating a
worker. Omitting `modelKey` still inherits — the first enabled model, else the
default — and naming the default model's own key is that same inheritance
rather than a selection (ADR subagent-model-opt-in).

`list` returns at most 100 non-deleted Agent sessions that can receive a
message, including sessions created independently of Session Orchestrator. Each
entry contains only its Session ID, title, status, updated time, readable
provider/model labels, and bounded creation links; it does not include a
transcript, project path, credentials, or message previews. The caller can
pass the returned Session ID to `send`, and `status`/`result` remain the
authoritative detail reads.

`spawn` and `send` are valid only during the plugin's active Agent tool
invocation. The broker injects `pluginId`, source `sessionId`, source `turnId`,
and an invocation identity; plugin arguments cannot supply or override those
values. A user-facing plugin panel may use `cancel` with its own plugin
identity, but cannot use that path to send or spawn work. The host enforces
the source permission ceiling, Agent-mode target, inbox and worker limits,
idempotency, and bounded autonomous hops. A requested completion callback is
a host-owned `completion` message linked to the source delivery and is created
at most once after the actual target turn settles.
The callback is session data, not a new user authorization, and completion
messages do not trigger another callback.

The renderer may read the separate sidebar collaboration projection, but a
plugin panel cannot invoke the mutation operations outside this gateway.

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
rolling 60s (`RATE_LIMITED`); 90s budget (`TIMEOUT`). Provider 429 and other
transient provider failures are retried inside the same call under the shared
provider retry budget (ADR 0206) and a `Retry-After` header is honored. Empty
model output is `INVALID_ARGUMENT`.

When the call still fails, the plugin receives the host's classified code
rather than a single generic failure — `PROVIDER_RATE_LIMITED` once the retry
budget is exhausted, `PROVIDER_UNAUTHORIZED`, `CONTEXT_TOO_LARGE`,
`NETWORK_ERROR` — so it can pace itself and report the cause. The broker
answers with whichever code the failing service classified, in the same
`data.errorCode` → `errorCode` → `code` precedence every other host boundary
uses.

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

`fetch` answers with the upstream response unchanged — `status`, `headers`, and
`bodyText` — so a `429` is data your plugin can read, `Retry-After` included,
rather than an error the host hides. The host does not retry, throttle, or
re-issue the request: retry and backoff after a `429` are your plugin's own
policy, and the response headers are the only backoff signal you get. A failed
call (`status >= 400`) is audited as `ok: false`, together with the
`retryAfter` it advertised when the response states one (§7).

```ts
pi.net.websocket.connect(input: {
  url: string
  headers?: Record<string, string>
  protocols?: string[]
  timeoutMs?: number
}): Promise<{ socketId: string }>

pi.net.websocket.send(input: { socketId: string; data: string | Uint8Array }): Promise<void>
pi.net.websocket.close(input: { socketId: string; code?: number; reason?: string }): Promise<void>
```

Requires `net.websocket`. `connect` is confined to `manifest.net.domains`
exactly like `fetch`, and `connect` / `close` are audited. Frames arrive as host
events: `net:websocket:open`, `net:websocket:message`, `net:websocket:close`,
`net:websocket:error`, each carrying the owning `socketId`, subscribed to with
`pi.events.on`. Only the owning plugin receives them.

The host owns the socket, so a plugin cannot exceed four sockets, send or
receive a frame above 1 MiB, or queue more than 4 MiB of unsent data; each of
those is refused (`LIMIT_EXCEEDED`) or closes the connection rather than growing
the host's memory. A connect carries `headers` and `protocols`, so an endpoint
that authenticates per connection works without exposing the credential to
plugin code. Refusals name the reason: `INVALID_ARGUMENT` for a non-`ws(s)` URL
or a malformed protocol token, `TIMEOUT` when the handshake does not finish,
`CONNECT_FAILED` when it fails, `NOT_FOUND` for a socket this plugin does not
hold, and `PERMISSION_DENIED` when the host is not in the allowlist.

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

The reviewed catalog includes `session/open(sessionId)` for a plugin UI to
open an existing durable session. Plugin-originated `session/create` and
`agent/prompt` calls refresh session state without changing the active
renderer session; `session/open` is explicit navigation.

This is the first-party plugin gateway to the reviewed operation catalog shared
with the opt-in local MCP control plane (ADR 0203 / D370). The two catalogs
differ only for operations marked plugin-only: the six
`session/collaboration/*` operations are callable through this gateway but are
deliberately absent from the MCP-visible catalog (`tools/list`,
`pi_control_describe`, and the `pi_desktop_invoke` enum), because they require
an authenticated plugin invocation context and no renderer mutation channel
exists for them. The returned catalog omits Electron channel names and the
plugin never receives the MCP bearer token. Invocation reuses the controller,
IPC handler, lifecycle checks, completion event, and audit boundary; a plugin
cannot reach arbitrary Electron IPC.

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

## Scenic Settings contribution

`contributes.scenicThemes` is a declarative presentation contribution, not a
plugin page API. It provides localized card metadata for same-plugin themes and
declared preview assets. The host owns the Settings DOM, styles, selection,
focus behavior, slider draft, and Apply action. The plugin receives no Settings
bridge, renderer DOM access, arbitrary CSS, JavaScript, navigation, or actions.

The host persists Apply through the existing typed theme-variable boundary and
only for the declared `--nexus-backdrop-blur` variable. `ui.panel` windows and
`contributes.views` retain their independent native-view implementation.

Theme assets declared for scenic cards may be package-relative, in which case
the host resolves them inside the installed plugin package before rewriting the
matching CSS `url()` or card preview to `plugin-asset:`. Absolute declared
assets retain the external-path route. Neither route grants a plugin arbitrary
filesystem access (ADR 0288).

### audio (requires `audio.capture.background` / `audio.playback.background`)

**Callable, but the device backend is not implemented in this branch.**
`pi.audio` is present in the plugin host process and exposes exactly the ten
methods below. Each one keeps its permission requirement: the six capture
methods (`getInputDevices`, `openInput`, `closeInput`, `getCaptureState`,
`onInputFrame`, `offInputFrame`) require `audio.capture.background` and the
four playback methods (`openOutput`, `writeOutput`, `stopOutput`,
`closeOutput`) require `audio.playback.background`. Without the grant the call
is refused with `PERMISSION_DENIED` and audited under the permission name,
exactly like every other gated API. With the grant the host still has no device
backend, so every call is answered with a coded `UNSUPPORTED` refusal: the
message is `host api not available: audio.<method>` and the audit entry is
`{ api: "audio.<method>", ok: false, errorCode: "UNSUPPORTED" }`. The eight
asynchronous methods reject with that error; `onInputFrame` / `offInputFrame`
are synchronous registration helpers that cannot reject, so they throw an
`Error` carrying the same `code: "UNSUPPORTED"` instead of registering a
handler that could never fire. Nothing touches a device and no frame is ever
produced. `onInputFrame` registers a callback — it is not an event name — and
the frame shape is `PluginAudioInputFrame` in
`packages/plugin-sdk/src/index.ts`. When the device service lands, the
permission and this surface stay as they are and only the refusal is replaced
by real behaviour: the host owns the device, a plugin exchanges PCM16 frames
and never receives a device handle, `MediaStream`, OS device path, or Node
stream, one input stream per plugin is allowed, and disable, unload, or crash
stops capture and drops queued playback.

```ts
pi.audio.getInputDevices(): Promise<PluginAudioInputDevice[]>
pi.audio.openInput(options?: PluginAudioOpenInputOptions): Promise<PluginAudioInputSession>
pi.audio.closeInput(streamId: string): Promise<void>
pi.audio.getCaptureState(): Promise<PluginAudioCaptureState>
pi.audio.onInputFrame(handler: (frame: PluginAudioInputFrame) => void): void
pi.audio.offInputFrame(handler: (frame: PluginAudioInputFrame) => void): void
pi.audio.openOutput(options: PluginAudioOpenOutputOptions): Promise<PluginAudioOutputSession>
pi.audio.writeOutput(input: { streamId: string; data: Uint8Array }): Promise<void>
pi.audio.stopOutput(streamId: string): Promise<void>
pi.audio.closeOutput(streamId: string): Promise<void>
```

### keyboard (requires `keyboard.globalShortcut`)

```ts
pi.keyboard.registerGlobalShortcut(input: {
  id: string
  accelerator: string
  command: string
}): Promise<PluginGlobalShortcut>

pi.keyboard.unregisterGlobalShortcut(id: string): Promise<void>
pi.keyboard.listGlobalShortcuts(): Promise<PluginGlobalShortcut[]>

type PluginGlobalShortcut = {
  id: string
  accelerator: string
  command: string
  registered: boolean
  error?: string
}
```

The host, not the plugin, owns Electron's `globalShortcut`. A plugin maps an
accelerator to one of its own commands, and the host registers, conflict-checks,
triggers, and releases it; no keyboard hook, `before-input-event`, raw input
device, or key event stream is ever exposed, and a trigger runs exactly one
command belonging to that plugin.

`command` must already be registered by the calling plugin; anything else fails
`INVALID_ARGUMENT`. An accelerator reserved by the operating system, one
PI-Desktop itself currently spends (by default `Alt+Space` opens the plugin
launcher and `Alt+Shift+W` shows or hides the window; once the user rebinds one of
them, the freed accelerator is available again), or one held by another plugin
is refused rather than taken over, and a refused re-registration leaves the
previous binding in place.
Refusals are returned, not thrown: `registerGlobalShortcut` resolves with
`registered: false` and an `error` of `SHORTCUT_CONFLICT`, `SHORTCUT_UNAVAILABLE`
(platform refusal), `INVALID_ACCELERATOR`, or `LIMIT_EXCEEDED` (at most 8
entries per plugin). `UNSUPPORTED` and `INVALID_ARGUMENT` are thrown.
Registering an `id` again replaces that entry's accelerator.

Every `contributes.globalShortcuts` entry that declares a `default` is
registered by the host after the plugin's load, but only when its command
actually registered; an entry without a `default` waits for a
`registerGlobalShortcut` call. `unregisterGlobalShortcut` drops one entry and
does nothing for an unknown id; `listGlobalShortcuts` lists what the host
currently holds for the calling plugin. Everything is released on disable,
unload, and crash, and register / unregister are audited.

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
- `workspace:changed` — payload is the `workspace.get()` object or `null`,
  sent when the cached workspace path changes: the primary `path` and `name`,
  plus `projectId` and `roots` when the folder belongs to a project group
  (ADR 0263). The first workspace of a run may arrive once without the folders
  and repeat once with them, because the group records are read after that
  first push.
- `plugin:settingsChanged` is delivered after edits from the generated Plugins
  settings UI.
- `appearance:changed` — payload is `PluginAppearance`, sent whenever the app
  palette or language changes, so a plugin process can relabel live the same way
  an open panel does (ADR 0280).
- `session:modelChanged` — `{ sessionId, modelKey, thinkingLevel }`, sent after
  a successful `session.configure` that changes provider, model, or thinking
  level.
- `session:turnEnded` — payload is
  `{ sessionId: string; turnId: string; reason: "completed" | "aborted" | "error" }`,
  sent once per host turn at the end of its teardown, after the durable
  `session.endTurn` attempt. A turn is the one `session.beginTurn` created: a
  user submission, an approved plan execution, or a scheduled run, and a queued
  item that never started produces no event. `completed`, `aborted`, and
  `error` are the three terminal reasons. The event carries the `turnId` the
  terminal runtime event identified, not whichever turn happens to be active,
  so a late event from an earlier turn cannot settle a newer one. Delivery is
  fire-and-forget: there is no ack and no replay, so a plugin that is alive and
  subscribed receives it once, and a delivery that races a plugin crash,
  reload, or host quit is not guaranteed. Receiving it does **not** mean every
  in-flight tool of that turn has exited — late results can still arrive — so a
  plugin must serialise or otherwise scope its cleanup by `turnId`. The event
  also needs no new permission: it travels on the existing event channel, and
  subscribing to an unknown event name does not error. No published host emits it
  yet — 0.14.8 does not include it — so a plugin that depends on it must require
  the release that actually ships it rather than assume 0.14.7 or 0.14.8.

A throwing handler is logged and does not affect other listeners or the plugin.

Planned events:
- `session:activated`

## 6. Panel bridge API

The Panel UI does not get the full `pi` directly; instead:

```ts
window.pluginBridge.invoke(channel, payload?)
window.pluginBridge.on(event, handler)
```

The same bridge serves both plugin surfaces: a detached `ui.panel` window and a
`contributes.views` surface docked in the work panel (ADR 0104). The channel
list, the permission gate, and the preload are identical, so one HTML entry
works in either placement. The only differences are chrome and the view
`location` below: a docked view has no window-control capsule and no drag band,
and its `--pi-plugin-titlebar-height` is `0px` rather than `46px`.

Detached panel pages using the current chrome contract declare
`<meta name="pi-plugin-chrome" content="v2">` and use the published variable
for normal-flow top spacing. The host preserves that page-owned spacing. A
page without the marker remains supported through the legacy additive offset.

### 6.1 Floating widgets

A manifest may declare `"ui": { "shape": "widget" }`. The panel then opens as a
floating widget: the same sandboxed, permission-gated page in a transparent,
frameless window with no 46px drag band, no control capsule, and no rectangular
native shadow. The page owns its whole rectangle and normally paints a
silhouette smaller than it — a round orb, for instance — so the host must not
draw a frame around that silhouette.

- `--pi-plugin-titlebar-height` is `0px`, and the legacy additive top offset is
  not applied either, whatever chrome marker the page declares.
- The placement is published before page scripts run as
  `document.documentElement.dataset.piPluginPanelShape`: `panel`, `widget`, or
  `view`.
- Dragging uses a whole-window drag map: empty space moves the window, while
  standard controls (`button`, `input`, `a`, `[tabindex]`, …) and every element
  marked `data-pi-plugin-no-drag` stay clickable.
- A widget has no capsule, so the host owns an equivalent menu behind the
  surface's own context menu: close, minimize, and always on top. A plugin may
  still close its own widget through `ui.closePanel()`.
- `ui.width` / `ui.height` are honoured down to 120×120 (a panel's minimum stays
  360×280). `ui.alwaysOnTop` pins a widget above other windows, and
  `ui.resizable` defaults to `false` for a widget and `true` for a panel.
- Nothing else changes: same preload, same `pluginBridge` channels, same
  permission gate, same session partition and egress policy.

A docked view may also be given one subject to show. The `location` a work-panel
tab already carries is delivered to any contributed view — not only
`pi.browser`, whose address bar keeps its own navigation channel: on creation it
travels as the view entry URL's `piViewOpen` query parameter, and once the
document has finished loading it arrives as the `view:open` event. A location
that reaches the host before the first load restarts the load instead, and a
view that is already loaded is never navigated, so unsaved work inside a plugin
is not discarded; re-opening the same location does nothing. The payload is
opaque to the host — each plugin decides what its `location` means — and it
needs no permission and adds no SDK method.

The host-owned preload forwards only fixed channels to the plugin runtime:

| Channel | Required permission |
|---|---|
| `ui.showToast`, `ui.closePanel` | None beyond the loaded panel |
| `ui.notify` | `notify` |
| `ui.getNotificationPermission`, `ui.requestNotificationPermission`, `ui.showNativeNotification` | `notify` |
| `plugin.getSettings`, `workspace.get`, `app.getAppearance` | None |
| `app.setTheme`, `themes.upsert`, `themes.remove`, `themes.list` | `ui.theme` |
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
- `workspace:changed` — payload is the `workspace.get()` object or `null`,
  sent when the open project changes: the primary `path` and `name`, plus
  `projectId` and `roots` when the folder belongs to a project group
  (ADR 0263).
- `view:open` (docked work-panel views only; a detached `ui.panel` window never
  receives it) — payload is `{ path: string }`, the location the host asked this
  view to show. A view created with a location already carried it in its entry
  URL; this event delivers a later one.
- `session:turnEnded` — the same payload as the plugin-process event in §5,
  sent when a host turn reaches a terminal state.

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
- status / retryAfter (`net.fetch`: the upstream status of a completed call, and
  for a failed one the `Retry-After` it stated — never the header set or body)

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
- `speech.registerAdapter` / `unregisterAdapter` (`speech.adapter.register`)
- `models.list`, `session.getLlmContext`
- `clipboard.*`, `shell.openExternal`, `net.fetch`
- `browser.*` (guest CDP; `browser.cdp`)
- `services.register` / `unregister`, `bus.publish` / `subscribe`, `events.on` / `off`
- `keyboard.registerGlobalShortcut` / `unregisterGlobalShortcut` / `listGlobalShortcuts`
  (`keyboard.globalShortcut`; the host owns Electron `globalShortcut`)
- `net.websocket.connect` / `send` / `close` (`net.websocket`; host-owned
  sockets, allowlist-confined, bounded, released with the plugin)

`pi.audio.*` is present in the plugin host process and callable: all ten
methods are gated by `audio.capture.background` / `audio.playback.background`,
and this branch ships no device backend, so an authorized call is answered with
a coded `UNSUPPORTED` refusal under the method's own audit entry
(`audio.<method>`, `ok: false`); `onInputFrame` / `offInputFrame` throw the same
code synchronously because they cannot reject. No device is opened.

Native plugin notifications use the Electron main-process notification surface;
they do not create durable rows in the task notification inbox and do not
activate a session on click.

Declarative contributions have no `pi.*` counterpart on purpose: skills, themes,
and MCP servers are read from the manifest by the host, so a plugin cannot add
one at runtime.

All high-risk entry points assert declared+granted permissions and emit audit log lines.
Plugin panels no longer receive the full `pi` object; they use `window.pluginBridge.invoke`.
