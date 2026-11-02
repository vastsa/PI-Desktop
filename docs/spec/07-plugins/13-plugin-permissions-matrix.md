# 13. Plugin Permissions Matrix

## 1. Goals

Provide a permission–capability–risk–default-policy reference table for reuse by UI copy and validation.

## 2. Matrix

| Permission | Risk | Allowed API / capability | Default policy | Notes |
|---|---|---|---|---|
| `ui.panel` | low | Open the plugin panel | Granted at install | Needed by almost all UI plugins |
| `ui.view` | low | `contributes.views` are listed in the work panel and may be opened | Granted at install | Same isolation as a panel window: sandboxed page, per-plugin partition, `net.domains` egress. Filtered by activation scope |
| `ui.theme` | low | `contributes.themes` CSS is loaded and offered in Settings; runtime `pi.themes.upsert` / `remove` / `list` and `pi.app.setTheme` (ADR 0260) | Granted at install | CSS is sanitized by the host; it cannot script. Declared `assets` are served over the host's read-only `plugin-asset:` scheme. `setTheme` may only select a built-in preference or a currently registered plugin theme. There is no per-plugin theme count cap |
| `ui.settings` | low | `contributes.scenicThemes` adds a host-rendered data-only Settings entry | Granted at install | Also needs `ui.theme`; no plugin Settings HTML, CSS, JavaScript, or bridge (ADR 0287) |
| `ui.window.appearance` | low | `contributes.windowAppearance` sets the native window background and Windows main-window corner request while one of the plugin's themes is selected | Granted at install | `#rrggbb` / `#rrggbbaa` background and integer `cornerRadius` 0..24 DIP; restores host background and the 12 DIP default request when the theme is gone. Windows 11 maps 0 to square and positive values to the system-rounded preference (not exact DIP radii); alpha is composited over the built-in theme color on its opaque window. Earlier Windows builds retain the requested DIP radius. macOS keeps native corners; its default translucent vibrancy surface ignores the colour, and the `Translucent window` switch turned off applies it to the opaque native surface (ADR 0332) |
| `clipboard.read` | medium | `clipboard.readText`, `clipboard.getHistory` | Confirm on first use | May read sensitive information and retained clipboard history |
| `clipboard.write` | medium | `clipboard.writeText` | Confirm on first use | Prevents clipboard pollution |
| `notify` | low | `ui.notify`, `ui.getNotificationPermission`, `ui.requestNotificationPermission`, `ui.showNativeNotification` | Can be granted by default | Native delivery is OS-controlled; avoid notification-spam abuse |
| `fs.read` | medium | `fs.readText` / `fs.stat` / `fs.readRange` / `fs.readPreview` / `fs.openDefault` / `fs.openInBrowser` / `fs.reveal` / `fs.glob` / `fs.list` / `fs.requestDirectory` / dropped-file grant | Granted at install, bounded by `manifest.fs.read` | `fs.stat` and `fs.readRange` share the read gate; Browser open accepts HTML only and creates a resource tab without granting CDP; a dropped-file grant is one-file, read-only, memory-only, and gesture-bound; all file calls remain root- and deny-list-checked |
| `fs.write` | high | `fs.writeText` | Granted at install, bounded by `manifest.fs.write` | Scope is required; a whole-tree pattern fails validation. Out of scope asks the user |
| `fs.delete` | high | `fs.remove` | Granted at install, bounded by `manifest.fs.delete` | Two tiers (`own` / `scope`), always via the OS trash, non-recursive, rate-braked (§2B) |
| `fs.read.workspace` | medium | — | Downgraded on load to `fs.read` with a whole-tree scope | Legacy name; predates scopes |
| `fs.write.workspace` | high | — | Downgraded on load to `fs.write` with **no** scope | Legacy name; every write asks the user until the manifest declares scope |
| `fs.delete.workspace` | high | — | Downgraded on load to `fs.delete` with `own: true` | Legacy name; only the plugin's own output goes without asking |
| `agent.tool.register` | high | Register an agent tool | Confirm at install | Tool execution is audited separately |
| `agent.prompt.inject` | high | Activate the catalog and on-demand bodies from `contributes.skills` | Deny by default / strong confirmation | Easily leads to behavior hijacking |
| `composer.transform` | medium | `contributes.composerTransforms` and `onComposerTransform` | Confirm at install | Runs only after an explicit Composer action. Receives the draft and optional model key, not session history or separate attachment/file-reference metadata; request and result are capped at 100,000 characters and audited |
| `composer.suggest` | medium | `pi.composer.suggest` / `pi.composer.clearSuggestion` | Confirm at install | Writes one dismissible line into the placeholder layer of the Composer for the session on screen, only while the draft is empty and only for the turn the plugin names. The user takes it with Tab, drops it with Esc, and typing, sending, a session switch, a new turn, the plugin stopping, a reload or a window close all end it. The plugin never sends it and never reads the draft. Text is folded to one line and cut at 200 characters; the lifetime defaults to 120 s and is capped at 10 minutes. Audited; a place that will not show it answers `{ shown: false, reason }` instead of throwing |
| `agent.extension` | high | Run `contributes.agentExtensions` modules inside the agent process | Explicit confirmation; local imports and development plugins only in v1.1 | Same access as the agent's own tools; the plugin sandbox does not apply (spec 16) |
| `renderer.extension` | high | `manifest.renderer` is evaluated inside the host renderer to mount UI slots; `rendererActions` and `rendererCallMethods` open the actions and `onRendererCall` methods that module may use | Explicit confirmation; local imports and development plugins only in v1.1, matching `agent.extension` | The module shares the host's own document, so a slot is a contract rather than a sandbox. A component may dispatch only the reviewed vocabulary (`plugin.call`, `composer.insertText`, `composer.readDraft`, `composer.replaceDraft`, `attachments.add` / `list` / `remove`), capped at 16, and `plugin.call` reaches only the calling plugin's own `onRendererCall` methods, capped at 32. Registrations are withdrawn when the plugin unloads; a self-drawn dialog lives in a layer the plugin opened itself |
| `provider.register` | high | `contributes.providers` become rows in the native provider list, owned by the plugin and refreshed from the manifest on load; unconfigured API-key rows with an endpoint also appear in Add Service, grouped by optional `category` and with optional hover/focus `description` | Explicit confirmation; local imports and development plugins only in v1.1, matching `agent.extension` | The user path refuses edits to the row (`PROVIDER_OWNED_BY_PLUGIN`); Add Service saves the key through the existing Host secret path. Only loaded plugins with this grant contribute entries; the chooser does not expose secrets or run plugin code. An empty API-key model list discovers models after key save. |
| `provider.oauth` | high | `onProviderOAuth`; host-rendered `pi.providers.oauth.prompt` / `notify` for a declared OAuth provider | Explicit confirmation | Required with `provider.register` for `authKind: "oauth"`. The callback can read and refresh only that contribution's encrypted credential. The Host keeps refresh tokens out of the renderer and Agent Runtime. Host-mediated callback egress still needs `net.fetch` and `manifest.net.domains`; plugin entry code itself is not an OS sandbox. One account is stored per provider contribution; sign out clears it |
| `net.fetch` | high | `net.fetch` | Deny by default | Confined to `manifest.net.domains`; an empty or malformed list means no egress (§2A) |
| `net.websocket` | high | `pi.net.websocket.connect` / `send` / `close` (host-owned sockets; at most 4 per plugin, 1 MiB frames) | Deny by default | Confined to `manifest.net.domains` like `net.fetch`; a refused host never reaches the transport, and every socket is closed when the plugin unloads, is disabled, or crashes |
| `net.anyHost` | high | Any host-owned egress path (`net.fetch`, `net.websocket`, panel session, remote HTTP MCP) | Confirm at install | Lifts the `manifest.net.domains` allowlist for user-typed endpoints (self-hosted servers); cloud metadata endpoints stay refused; nothing prompts at request time |
| `shell.openExternal` | medium | Open external link | Confirm on first use | Prevents phishing links |
| `mcp.server.local` | high | Spawn a `transport: "stdio"` MCP server declared in the manifest | Deny by default | Runs a local executable; its tools reach the agent |
| `mcp.server.remote` | high | Connect a `transport: "http"` MCP server | Deny by default | Sends tool arguments to a third-party endpoint; non-loopback HTTP is unencrypted |
| `background.service` | medium | Start `contributes.services` and keep the plugin process resident | Confirm at install | Supervised with backoff; visible on the Plugins page |
| `bus.publish` | medium | `bus.publish` to declared topics | Confirm at install | Other plugins can act on the message |
| `bus.subscribe` | medium | `bus.subscribe` to declared patterns | Confirm at install | Can observe another plugin's messages |
| `browser.cdp` | high | `pi.browser.*` against the host work-panel guest | Confirm at install | Guest bounds are clamped to the calling plugin view; CDP is allowlisted |
| `desktop.control` | high | `pi.desktop.listOperations`, `pi.desktop.invoke`, including the reviewed `session/collaboration/*` operations | Confirm at install | Shared with the local MCP control plane's reviewed operation catalog, except for operations marked plugin-only: the six `session/collaboration/*` operations reach the plugin gateway but are deliberately absent from the MCP-visible catalog and have no renderer mutation channel; collaboration `spawn`/`send` additionally require an active plugin Agent tool invocation, whose source Session/turn/invocation identity is injected by the host; panel cancellation is limited to that plugin's own deliveries; a `dangerous` operation needs `confirm: true` from the plugin **and** the user's answer to a host-owned native dialog that names the catalog operation; the MCP bearer token and Electron channel names are never exposed |
| `ui.microphone` | medium | `navigator.mediaDevices.getUserMedia({ audio: true })` inside the plugin's isolated panel | Confirm at install | Audio only; camera and every other device permission stay denied; no native handle or host secret reaches the plugin |
| `audio.capture.background` | high | `pi.audio.getInputDevices`, `openInput`, `closeInput`, `getCaptureState`, `onInputFrame` / `offInputFrame` (registered in the plugin API and gated by this permission; the two synchronous registration helpers throw the coded refusal) | Deny by default | Host owns the device; PCM16 frames only, no device handle or `MediaStream`. The host has no device backend yet, so an authorized call is refused with a coded `UNSUPPORTED` (audited); no device is opened |
| `audio.playback.background` | medium | `pi.audio.openOutput`, `writeOutput`, `stopOutput`, `closeOutput` (registered in the plugin API and gated by this permission) | Confirm at install | Host-owned playback queue, PCM16 only. The host has no device backend yet, so an authorized call is refused with a coded `UNSUPPORTED` (audited); no device is opened |
| `keyboard.globalShortcut` | medium | `pi.keyboard.registerGlobalShortcut`, `unregisterGlobalShortcut`, `listGlobalShortcuts`; `contributes.globalShortcuts` | Confirm at install | Host owns Electron `globalShortcut`; a shortcut only runs the plugin's own command; conflicts are refused (`SHORTCUT_CONFLICT` / `SHORTCUT_UNAVAILABLE` / `INVALID_ACCELERATOR` / `LIMIT_EXCEEDED`, max 8 per plugin); released on unload/disable/crash |
| `models.list` | medium | `pi.models.list` | Confirm at install | Ready provider/model rows only; no secrets |
| `project.create` | high | `pi.project.create` and explicit `projectId` on session import | Confirm at install | Creates or reuses a durable project row without activating the workspace; imported sessions remain unbound unless the id is supplied |
| `session.read` | high | `pi.session.getLlmContext` | Confirm at install | In-flight tool session only; compaction-aware projection (D019 / D336) |
| `session.autoTitle` | high | `pi.session.getAutoTitleContext`, `pi.session.setAutoTitle` | Confirm at install | First user prompt (≤1,000 chars) and first assistant reply (≤500 chars) only, for default-titled sessions; title writes are compare-and-set. It does not grant transcript reads |
| `session.import` | high | `pi.session.import`, `pi.session.importBatch` | Confirm at install | Imports only into the calling plugin's declared session sources; bounded and rate-limited |
| `session.read.own` | medium | `pi.session.list`, `pi.session.get`, `pi.session.listMessages` | Confirm at install | Reads only sessions imported by the calling plugin; no cross-plugin access |
| `session.update.own` | medium | `pi.session.rename` | Confirm at install | Renames only the calling plugin's active imported sessions |
| `session.delete.own` | high | `pi.session.delete` | Confirm at install | Trash/purge only the calling plugin's imported sessions; rate-limited |
| `usage.read` | medium | `pi.usage.listTurns` | Confirm at install | Read-only listing of completed-turn facts (per-turn token counters and identifiers, keyset-paginated); no message body and no write path |
| `agent.complete` | high | `pi.agent.complete` | Confirm at install | Host-owned one-shot; spends user quota; `includeSessionContext` also needs `session.read` |
| `speech.adapter.register` | high | `pi.speech.registerAdapter` / `unregisterAdapter` | Confirm at install | Registers a speech protocol. Handles stay in the guest; HTTP plans are executed by the host with the bound provider key and must stay on that origin. Built-in protocol ids are reserved |

The Default policy column is the intended policy. The current host does not
apply it per permission: the install and update review lists every declared
permission, marking the ones an update adds, and the installer refuses a grant
that leaves any declared permission out (`PLUGIN_PERMISSION_DENIED: missing
grant for <permission>`). Nothing prompts again at first use — `clipboard.*`
and `shell.openExternal` only check the stored grant. Auto-update skips any
update that adds permissions (§5).

## 2A. A permission is the switch; the manifest carries the range

Two capabilities are too coarse to be answered by a name alone, so the name says
whether the plugin may act and a manifest field says how far. Both fields are
enforced by the host, shown to the user next to the permissions, and validated at
install time.

| Field | Bounds | Absent or empty means |
|---|---|---|
| `net.domains` | Every host-owned egress path: the panel session, `pi.net.fetch`, `pi.net.websocket`, remote HTTP MCP endpoints | No egress at all, whatever `net.fetch` says |
| `fs.read` / `fs.write` / `fs.delete` | Which paths that file mode may touch | No standing reach; every access falls to a confirmation |

Failing closed on an absent field is what makes the two safe to omit: a
manifest that says nothing grants nothing. See
[04-plugin-security.md](04-plugin-security.md) §6 and §8.1, and ADR 0088.

The two are also linked. `fs.read` may declare the whole tree because a read
only becomes a leak when the bytes can leave, and `net.domains` closes that
half. `fs.write` and `fs.delete` are dangerous on their own, so a whole-tree
pattern (`**`, `**/*`, `*/**`, `./*`) fails manifest validation for those modes.

## 2B. Deletion

`fs.delete` is the one file mode whose damage is not undoable by re-running the
plugin, so it carries three bounds the other modes do not:

1. **Two tiers.** `own: true` lets a plugin remove files it wrote itself — the
   host keeps a write ledger in the plugin's data directory — with no scope and
   no prompt; a file the user has modified since drops out of the ledger.
   Deleting anything else needs a declared `scope`, and out-of-scope paths ask
   the user.
2. **The OS trash.** Removal goes through `shell.trashItem`, never `rm`, and
   never recursively: a non-empty directory is refused rather than emptied. The
   host keeps no copy of the user's data to provide this.
3. **A rate brake.** 50 deletes per rolling 60s per plugin. Past it the user is
   asked once with the reason given as rate rather than path, because
   `recursive: false` bounds one call and not a `glob` plus a loop.

## 3. Permission dependencies

- `ui.panel` is required to load a panel entry
- `ui.view` is required to contribute work panel views; it is independent of
  `ui.panel`, so a plugin may ship docked views without a detached window
- `ui.view` also covers `pi.ui.revealView`, which shows one of the plugin's own
  views in a session's work panel; following the selected session
  (`pi.session.getActive`, `session:activated`) needs no permission
- `agent.tool.register` is required to contribute agentTools
- When `fs.write` is present, it is recommended to also declare `fs.read`
- `manifest.fs.<mode>` requires the matching `fs.<mode>` permission; a scope
  nobody can use fails validation rather than being silently ignored
- `fs.requestDirectory` (the `userSelected` root) is gated on `fs.read`; writing
  or deleting inside the chosen directory still needs `fs.write` / `fs.delete`
- A contribution whose permission is missing fails manifest validation
  (`themes`, `views`, `providers` and OAuth providers, `agentExtensions`,
  `composerTransforms`, `globalShortcuts`, `windowAppearance`, `mcpServers`,
  `services`, `bus`); `skills` is the exception and is skipped at load time
  instead, and `scenicThemes` without `ui.settings` and `ui.theme` is not shown
  (see [02-plugin-manifest-schema.md](02-plugin-manifest-schema.md) §7)
- Lifecycle and state events need no permission: `workspace:changed`,
  `appearance:changed`, `session:modelChanged`, `session:turnEnded`,
  `session:activated`, and `plugin:settingsChanged` arrive on the existing plugin event channel, and subscribing to an unknown
  event name does not error

## 3A. Plan operating-state rule

Plugin tools are hidden and denied in Plan/Goal by default. A runtime tool
registration may opt in with non-empty `planSafeActions`; only an `args.action`
in that list may execute in those modes. The list is checked against the schema's
action enum when present. Keep the manifest descriptor and runtime registration
in sync: the runtime registration drives the executable tool. Risk `low`, session
grants, and `auto` do not substitute for the declaration. Host policy and the
plugin runner both check it; a disallowed runner action is `PERMISSION_DENIED`.
The declaration is an author assertion of read-only behavior, not a side-effect
sandbox (ADR 0211).

## 4. Permission display copy

The copy below is the `plugins.permissions.*` entry in the en and zh-CN catalogs
(`packages/i18n/src/locales/`). The install and update review shows this label
with the matching `plugins.permissionHelp.*` line under it, and the Plugins page
shows it as a chip; the label falls back to the raw permission key when the
catalog has no entry.
The declared file scope is shown beside the permissions on the installed
plugin's row (Files), so "Edit files" is followed by the list.

| Permission | English copy | zh-CN copy |
|---|---|---|
| `fs.read` | Read files | 读取文件 |
| `clipboard.read` | Read the clipboard and its history | 读取剪贴板及其历史 |
| `fs.write` | Edit files | 修改文件 |
| `fs.delete` | Delete files | 删除文件 |
| `notify` | Show in-app and native notifications | 显示应用内和系统通知 |
| `agent.tool.register` | Add tools for the agent | 为智能体添加工具 |
| `agent.prompt.inject` | Adjust agent instructions | 调整智能体指令 |
| `agent.extension` | Run code inside the agent | 在 agent 内运行代码 |
| `renderer.extension` | Draw UI in chat slots | 在聊天插槽绘制界面 |
| `net.fetch` | Use the network | 访问网络 |
| `shell.openExternal` | Open external links | 打开外部链接 |
| `ui.theme` | Provide a theme | 提供主题 |
| `ui.window.appearance` | Customize window appearance | 自定义窗口外观 |
| `mcp.server.local` | Run a local MCP server | 运行本地 MCP 服务 |
| `mcp.server.remote` | Reach a remote MCP server | 连接远端 MCP 服务 |
| `background.service` | Keep a background service running | 保持后台服务运行 |
| `bus.publish` | Send messages to other plugins | 向其他插件发送消息 |
| `bus.subscribe` | Receive messages from other plugins | 接收其他插件的消息 |
| `browser.cdp` | Control the work-panel browser | 控制工作面板浏览器 |
| `models.list` | List authenticated models | 列出已登录的模型 |
| `session.read` | Read the current conversation sent to the model | 读取当前发给模型的对话 |
| `usage.read` | Read usage statistics | 读取用量统计 |
| `agent.complete` | Run a one-shot completion with your models | 用你的模型发起一次补全 |
| `composer.transform` | Transform text in the Composer | 转换输入框中的文本 |
| `composer.suggest` | Offer a suggestion in the Composer | 在输入框中给出建议 |
| `speech.adapter.register` | Register a speech adapter | 注册语音适配器 |
| `audio.capture.background` | Use the microphone in the background | 后台使用麦克风 |
| `audio.playback.background` | Play audio in the background | 后台播放声音 |
| `keyboard.globalShortcut` | Register system-wide shortcuts | 注册系统级快捷键 |
| `net.websocket` | Open real-time connections | 建立实时双向连接 |
| `ui.panel` | Show a plugin panel | 显示插件面板 |
| `ui.microphone` | Use the microphone | 使用麦克风 |
| `clipboard.write` | Write to the clipboard | 写入剪贴板 |
| `provider.register` | Add providers to the model list | 将服务添加到模型列表 |
| `provider.oauth` | Sign in to a provider with OAuth | 通过 OAuth 登录 Provider |
| `desktop.control` | Control the desktop | 控制桌面操作 |
| `net.anyHost` | Access any network address | 访问任意网络地址 |
| `session.autoTitle` | Read first-turn title context and update automatic titles | 读取首轮标题上下文并更新自动标题 |

These permissions have no catalog entry today and are shown as their raw key:
`ui.settings`, `session.import`, `session.read.own`, `session.update.own`, `session.delete.own`, `ui.view`, `project.create`.

## 5. Adding permissions on upgrade

If new permissions appear on upgrade:

1. Compute the diff
2. Force user confirmation
3. If not confirmed, cancel the upgrade or disable the new capabilities (canceling the upgrade is recommended)

## 6. Runtime check pseudocode

```ts
assertPermission(pluginId, perm) {
 if (!granted(pluginId, perm)) throw ERROR_PERMISSION_DENIED
}
```

Every Host API entry point must assert first. A file entry point then passes
three more gates, in this order — a later gate can only refuse, never widen:

```ts
assertFsAccess(pluginId, mode, requestedPath, sessionId) {
 assertPermission(pluginId, `fs.${mode}`)              // declared AND granted
 full = realpathWithinRoot(root(pluginId, mode, sessionId), requestedPath)
 if (!full) throw NOT_FOUND | INVALID_ARGUMENT         // symlinks resolved first
 if (isDenied(full) || isHostReserved(full)) throw ERROR_PERMISSION_DENIED
 if (!inScope(full, declaredScope(pluginId, mode))) await confirmWithUser(...)
}
```
The `workspace` root is the invoking tool session's project, falling back to the
visible workspace for a panel call (ADR 0266).

## 7. Acceptance

1. Unauthorized API calls fail
2. Permission copy is visible in the install UI, and a file permission shows its
   declared scope alongside
3. Upgrades that add permissions prompt the user
4. A write or delete outside the declared scope prompts, and a denial is audited
   as `PERMISSION_DENIED`
5. `.env` and `.git/**` stay unreadable under a whole-tree read scope, and do not
   appear in `fs.glob` results either
6. A symlink inside the root pointing outside it does not carry an access out
7. A delete lands in the OS trash, refuses a non-empty directory, and is
   interrupted past 50 removals in a rolling minute
8. A plugin declaring only the legacy `fs.*.workspace` names loses write and
   delete reach, and the Plugins page says so
