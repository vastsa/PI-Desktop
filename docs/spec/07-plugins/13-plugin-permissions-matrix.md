# 13. Plugin Permissions Matrix

## 1. Goals

Provide a permission–capability–risk–default-policy reference table for reuse by UI copy and validation.

## 2. Matrix

| Permission | Risk | Allowed API / capability | Default policy | Notes |
|---|---|---|---|---|
| `ui.panel` | low | Open the plugin panel | Granted at install | Needed by almost all UI plugins |
| `ui.view` | low | `contributes.views` are listed in the work panel and may be opened | Granted at install | Same isolation as a panel window: sandboxed page, per-plugin partition, `net.domains` egress. Filtered by activation scope |
| `ui.theme` | low | `contributes.themes` CSS is loaded and offered in Settings; runtime `pi.themes.upsert` / `remove` / `list` and `pi.app.setTheme` (ADR 0260) | Granted at install | CSS is sanitized by the host; it cannot script. Declared `assets` are served over the host's read-only `plugin-asset:` scheme. `setTheme` may only select a built-in preference or a currently registered plugin theme. There is no per-plugin theme count cap |
| `ui.window.appearance` | low | `contributes.windowAppearance` sets the native window background while one of the plugin's themes is selected | Granted at install | `#rrggbb` / `#rrggbbaa` only; applied per resolved palette and back to the host default once the theme is gone. macOS keeps vibrancy |
| `clipboard.read` | medium | `clipboard.readText`, `clipboard.getHistory` | Confirm on first use | May read sensitive information and retained clipboard history |
| `clipboard.write` | medium | `clipboard.writeText` | Confirm on first use | Prevents clipboard pollution |
| `notify` | low | `ui.notify`, `ui.getNotificationPermission`, `ui.requestNotificationPermission`, `ui.showNativeNotification` | Can be granted by default | Native delivery is OS-controlled; avoid notification-spam abuse |
| `fs.read` | medium | `fs.readText` / `fs.stat` / `fs.readRange` / `fs.readPreview` / `fs.openDefault` / `fs.reveal` / `fs.glob` / `fs.list` / `fs.requestDirectory` / dropped-file grant | Granted at install, bounded by `manifest.fs.read` | `fs.stat` and `fs.readRange` share the read gate; a dropped-file grant is one-file, read-only, memory-only, and gesture-bound; all file calls remain root- and deny-list-checked |
| `fs.write` | high | `fs.writeText` | Granted at install, bounded by `manifest.fs.write` | Scope is required; a whole-tree pattern fails validation. Out of scope asks the user |
| `fs.delete` | high | `fs.remove` | Granted at install, bounded by `manifest.fs.delete` | Two tiers (`own` / `scope`), always via the OS trash, non-recursive, rate-braked (§2B) |
| `fs.read.workspace` | medium | — | Downgraded on load to `fs.read` with a whole-tree scope | Legacy name; predates scopes |
| `fs.write.workspace` | high | — | Downgraded on load to `fs.write` with **no** scope | Legacy name; every write asks the user until the manifest declares scope |
| `fs.delete.workspace` | high | — | Downgraded on load to `fs.delete` with `own: true` | Legacy name; only the plugin's own output goes without asking |
| `agent.tool.register` | high | Register an agent tool | Confirm at install | Tool execution is audited separately |
| `agent.prompt.inject` | high | Inject a system prompt; activates `contributes.skills` | Deny by default / strong confirmation | Easily leads to behavior hijacking |
| `agent.extension` | high | Run `contributes.agentExtensions` modules inside the agent process | Explicit confirmation; local imports and development plugins only in v1.1 | Same access as the agent's own tools; the plugin sandbox does not apply (spec 16) |
| `provider.register` | high | `contributes.providers` become rows in the native provider list, owned by the plugin and refreshed from the manifest on load | Explicit confirmation; local imports and development plugins only in v1.1, matching `agent.extension` | The user path refuses the row (`PROVIDER_OWNED_BY_PLUGIN`); credentials stay in the Host secret store under the usual provider refs; `oauth` declarations are not enabled yet |
| `net.fetch` | high | `net.fetch` | Deny by default | Confined to `manifest.net.domains`; an empty or malformed list means no egress (§2A) |
| `net.websocket` | high | `pi.net.websocket.connect` / `send` / `close` (host-owned sockets; at most 4 per plugin, 1 MiB frames) | Deny by default | Confined to `manifest.net.domains` like `net.fetch`; a refused host never reaches the transport, and every socket is closed when the plugin unloads, is disabled, or crashes |
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
| `session.import` | high | `pi.session.import`, `pi.session.importBatch` | Confirm at install | Imports only into the calling plugin's declared session sources; bounded and rate-limited |
| `session.read.own` | medium | `pi.session.list`, `pi.session.get`, `pi.session.listMessages` | Confirm at install | Reads only sessions imported by the calling plugin; no cross-plugin access |
| `session.update.own` | medium | `pi.session.rename` | Confirm at install | Renames only the calling plugin's active imported sessions |
| `session.delete.own` | high | `pi.session.delete` | Confirm at install | Trash/purge only the calling plugin's imported sessions; rate-limited |
| `agent.complete` | high | `pi.agent.complete` | Confirm at install | Host-owned one-shot; spends user quota; `includeSessionContext` also needs `session.read` |

## 2A. A permission is the switch; the manifest carries the range

Two capabilities are too coarse to be answered by a name alone, so the name says
whether the plugin may act and a manifest field says how far. Both fields are
enforced by the host, shown to the user next to the permissions, and validated at
install time.

| Field | Bounds | Absent or empty means |
|---|---|---|
| `net.domains` | Every host-owned egress path: the panel session, `pi.net.fetch`, remote HTTP MCP endpoints | No egress at all, whatever `net.fetch` says |
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
- `agent.tool.register` is required to contribute agentTools
- When `fs.write` is present, it is recommended to also declare `fs.read`
- `manifest.fs.<mode>` requires the matching `fs.<mode>` permission; a scope
  nobody can use fails validation rather than being silently ignored
- `fs.requestDirectory` (the `userSelected` root) is gated on `fs.read`; writing
  or deleting inside the chosen directory still needs `fs.write` / `fs.delete`
- A contribution whose permission is missing fails manifest validation
  (`themes`, `mcpServers`, `services`, `bus`); `skills` is the exception and is
  skipped at load time instead (see
  [02-plugin-manifest-schema.md](02-plugin-manifest-schema.md) §7)
- Lifecycle and state events need no permission: `workspace:changed`,
  `session:modelChanged`, `session:turnEnded`, and `plugin:settingsChanged`
  arrive on the existing plugin event channel, and subscribing to an unknown
  event name does not error

## 3A. Plan operating-state rule

Every `agentTools` contribution is denied in Plan, regardless of this matrix's
risk or default policy. `agent.tool.register` authorizes registration for
Agent, not visibility in Plan. The host returns `PLUGIN_DISABLED_IN_PLAN` for a
direct Plan call and records the denial. Plugin tools become eligible only
after the same Agent is approved into Agent mode.

## 4. Permission display copy

English is the primary copy. The zh-CN column holds the localized example strings.
A file permission is never shown alone: the declared scope is rendered beside it,
so "Modify the files it lists" is followed by the list.

| Permission | English copy | zh-CN example |
|---|---|---|
| `fs.read` | Read the files it lists | 读取它列出的文件 |
| `clipboard.read` | Read the current clipboard and retained history | 读取当前剪贴板和保留的历史 |
| `fs.write` | Modify the files it lists | 修改它列出的文件 |
| `fs.delete` | Delete the files it lists, to the trash | 删除它列出的文件（进回收站） |
| `notify` | Show in-app and native notifications | 显示应用内和系统通知 |
| `agent.tool.register` | Provide executable tools to the AI Agent | 向 AI Agent 提供可执行工具 |
| `agent.prompt.inject` | Adjust agent instructions | 调整智能体指令 |
| `agent.extension` | Run code inside the agent | 在 agent 内运行代码 |
| `net.fetch` | Access the network | 访问网络 |
| `shell.openExternal` | Open external links | 打开外部链接 |
| `ui.theme` | Provide a theme | 提供主题 |
| `ui.settings` | Add a sandboxed Settings entry in Extensions | 在“扩展”中添加沙盒设置项 |
| `ui.window.appearance` | Set the window background | 设置窗口背景 |
| `mcp.server.local` | Run a local MCP server | 运行本地 MCP 服务 |
| `mcp.server.remote` | Reach a remote MCP server | 连接远端 MCP 服务 |
| `background.service` | Keep a background service running | 保持后台服务运行 |
| `bus.publish` | Send messages to other plugins | 向其他插件发送消息 |
| `bus.subscribe` | Receive messages from other plugins | 接收其他插件的消息 |
| `browser.cdp` | Control the work-panel browser | 控制工作面板浏览器 |
| `models.list` | List authenticated models | 列出已登录的模型 |
| `session.read` | Read the current conversation sent to the model | 读取当前发给模型的对话 |
| `session.import` | Import bounded session history into your declared sources | 导入受限的会话历史到已声明的数据源 |
| `session.read.own` | Read sessions imported by this plugin | 读取此插件导入的会话 |
| `session.update.own` | Rename sessions imported by this plugin | 重命名此插件导入的会话 |
| `session.delete.own` | Trash or purge sessions imported by this plugin | 将此插件导入的会话移入回收站或清除 |
| `agent.complete` | Run a one-shot completion with your models | 用你的模型发起一次补全 |
| `audio.capture.background` | Use the microphone in the background | 后台使用麦克风 |
| `audio.playback.background` | Play audio in the background | 后台播放声音 |
| `keyboard.globalShortcut` | Register system-wide shortcuts | 注册系统级快捷键 |
| `net.websocket` | Open real-time connections | 建立实时双向连接 |

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
