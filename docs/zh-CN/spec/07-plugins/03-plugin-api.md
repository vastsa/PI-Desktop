# 03. 插件 API

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/03-plugin-api) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 设计原则

1. 小巧稳定
2. 权限驱动
3. 异步优先
4. 可审计
5、不要暴露主机内部对象

## 2. 运行时注入的对象

在插件运行时内部，有一个全局可用：

```ts
declare const pi: PiPluginHostApi;
```

## 3. API 概述（MVP）

### 应用程序
```ts
pi.app.getVersion(): Promise<string>
pi.app.getLocale(): Promise<string>
pi.app.getAppearance(): Promise<PluginAppearance>
```

`app.getAppearance` 返回宿主当前正在呈现的外观，让插件（或它的面板）可以
完全跟随应用的语言与配色：

```ts
type PluginAppearance = {
  theme: string        // 原始偏好："light" | "dark" | "system" | "plugin:<pluginId>:<themeId>"
  base: "light" | "dark" | "system"  // 该偏好解析出的调色板
  locale: string       // 当前语言标签（例如 "en"、"zh-CN"）
  pluginTheme: { id: string; base: "light" | "dark"; css: string } | null
}
```

面板通过桥通道 `app.getAppearance` 读取同一个值，并在 `appearance:changed`
事件（见下文）上收到实时更新。在没有该通道的旧宿主上，调用以
`UNSUPPORTED` 拒绝；面板应回退到操作系统偏好和它自己的面板内选择。

### 插件
```ts
pi.plugin.getId(): string
pi.plugin.getManifest(): PluginManifestV1
pi.plugin.getSettings<T=Record<string, unknown>>(): Promise<T>
pi.plugin.setSettings(partial: Record<string, unknown>): Promise<void>
pi.plugin.getDataPath(): Promise<string> // plugin-private directory
```

插件页面会渲染 `contributes.settings` 中声明的字段，并将修改持久化到插件私有设置文件。
支持生成字符串、数字、布尔、枚举、JSON 和 `shortcut` 控件。快捷键仅属于插件域：只有在
PI-Desktop 窗口聚焦且插件激活范围匹配当前项目时，才会调用声明的命令；本版本不会注册操作系统
全局快捷键。用户编辑后，主机会向插件发送 `plugin:settingsChanged`，便于刷新内存中的配置。

### 命令
```ts
pi.commands.register(def: {
 id: string
 title: string
 keywords?: string[]
 run: () => Promise<void> | void
}): Promise<void>

pi.commands.unregister(id: string): Promise<void>
```

### 用户界面
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

`ui.notify` 仍然是应用内 Toast。本机交付可通过以下方式选择加入
`ui.showNativeNotification` 并由相同的清单 `notify` 保护
许可。 `requestNotificationPermission` 执行平台原生
通过显示简短的确认通知来进行权限探测； Electron 确实
不暴露跨平台只读通知权限API，所以
`unknown` 在第一次探测之前以及操作系统执行探测操作时返回
不报告结果。本机交付是尽力而为：操作系统策略可能会抑制
横幅而不更改持久任务通知收件箱。

### 项目（需要 `project.create`）

```ts
pi.project.create(input: { path: string }): Promise<{
  projectId: number
  path: string
  name: string
}>
```

该方法创建或复用宿主持久项目记录，但不会切换当前工作区。返回的
`projectId` 可以显式传给 `pi.session.import()` 或
`pi.session.importBatch()` 的单项。插件传入项目 id 时必须持有
`project.create`；省略 `projectId` 的导入会保持未绑定，`projectPath` 只是历史来源
元数据，本身不会创建项目。

### 工作区/fs
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
  path: string;        // 相对 root，可直接用于 readText / list
  isDirectory: boolean;
  size?: number;       // 仅文件
}>>
pi.fs.remove(pathFromRoot: string): Promise<void>
pi.fs.requestDirectory(): Promise<{ path: string; name: string } | null>
```

`fs.readPreview` 为一份已存在且可读取的文件做应用内预览分类。它与 `fs.readText`
使用相同的 `fs.read` 检查，拒绝目录，并返回 `text`（上限 512 KiB）、`image`
（上限 5 MiB，data URL）、`binary` 或 `tooLarge`。插件不会收到绝对路径。

`fs.openDefault` 使用操作系统默认关联应用打开一个已存在的文件。它与
`fs.readText` 使用相同的 `fs.read` 根目录、符号链接、受保护路径、拒绝列表和范围检查；
目录会被拒绝。主机会记录这次操作，并且不会接受插件传入的绝对路径。

`fs.reveal` 在操作系统文件管理器中显示一个已存在且可读取的文件，并在平台支持时选中它。
它使用相同的 `fs.read` 检查，拒绝目录，并记录成功和失败。插件只提供和接收相对根目录的路径。

路径相对于该模式的 root —— 工作区，或者当该模式声明
`root: "userSelected"` 时，用户通过 `requestDirectory()` 选中的目录。
每种模式能到哪些路径由 `manifest.fs` 决定；范围之外会问用户，
而凭证 deny-list 压过两者（参见
[04-plugin-security.md](/zh-CN/spec/07-plugins/04-plugin-security) §6）。
`remove` 不递归，并且把路径移进系统回收站。

`list` 返回单个目录的条目（按名称排序），使插件可以惰性遍历目录树，
而不必拉取整个仓库的 `glob` 再自行重组。它施加与 `glob` 完全相同的守卫，
因为列目录本身就是一次读取：读取范围之外的文件不会出现，被拒绝的名称与
受保护路径不会出现，`node_modules` 之类的重目录会被跳过。目录始终返回，
因此即使范围很窄也能得到可导航的树；单次调用最多返回 1000 个条目。

###代理
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

注册的插件代理工具是仅代理的贡献。在 Plan 期间
主机将它们从模型工具列表中过滤出来并拒绝直接执行
`PLUGIN_DISABLED_IN_PLAN`，包括当明显风险为 `low` 时，用户
具有 `allow-session` 授予，或者会话权限模式为 `auto`。一个
成功的计划批准使相同的注册工具再次符合资格
所选的 Agent 权限策略。

```ts
type ToolExecContext = {
 sessionId: string
 turnId?: string
 /** 本会话执行模型，`providerId/modelId`。这是配置，不是转录。 */
 modelKey?: string
 thinkingLevel?: ThinkingLevel
 signal?: AbortSignal
 log: (msg: string) => void
}
```

### models（需要 `models.list`）
```ts
pi.models.list(): Promise<PluginModelInfo[]>

type PluginModelInfo = {
  key: string                 // `${providerId}/${modelId}` — 第一个斜杠切开
  providerId: string
  providerName: string
  modelId: string
  label: string
  supportsReasoning: boolean
  thinkingLevels: ThinkingLevel[]
}
```

只返回已启用且已认证的 provider 行（API key、OAuth 或 `authKind: "none"`）。不含密钥。
`models.list` 也是面板桥通道，选择器页面可以自行填充。宿主传输不可用时返回空列表，不记警告（D080）。

### session（需要 `session.read`）
```ts
pi.session.getLlmContext(): Promise<PluginLlmContext>
```

插件不能传入 session id。身份来自进行中的 `plugins.execute` 会话（D333 / D336）。
在工具执行之外调用会以 `INVALID_ARGUMENT` 失败。子代理行会被省略。插件自己
正在飞行的工具调用会从尾部剥掉。compaction 摘要替换检查点之前的历史。
合计内容上限 200k 字符。

### 插件拥有的会话（P0/P1；需要对应权限）

插件只能导入和管理归属于自身的会话。来源必须在
`manifest.contributes.sessionSources` 中声明；主机提供本地化来源标签，并生成
持久会话 id 与消息 id。导入会话不会绑定工作区、provider 或 model；只有调用方显式
提供已有的 `projectId` 时才会绑定项目；原始导入值仍在 `get().history` 中返回。

```ts
type PluginSessionSourceContrib = {
  id: string
  label?: string | { en: string; "zh-CN": string }
}

pi.session.import(input: {
  source: string
  externalId: string
  title: string
  projectId?: number | null // 来自 pi.project.create；省略即未绑定
  projectPath?: string | null
  modelId?: string | null
  providerId?: string | null
  createdAt: string // RFC3339
  updatedAt: string // >= createdAt
  messages: Array<{
    role: "user" | "assistant" | "tool"
    content: string
    createdAt: string // 会话内单调递增
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

导入以 `(pluginId, source, externalId)` 幂等。`skip` 批量导入逐项继续，`fail`
批量导入在任一项失败时全部回滚。`trash` 隐藏会话但保留其转录本和来源；`purge`
同时删除两者并允许重新导入。读取、重命名和删除均按归属限制；未声明来源返回
`PERMISSION_DENIED`。

当会话显式绑定项目时，`projectId` 和 `bound.workspace` 报告该绑定，
`get().projectPath` 解析为绑定项目的当前路径；原始导入的 `projectPath` 保留在
`get().history` 中。

导入、重命名或删除成功后，Electron main 会为这次变更发送一次宿主拥有的
`sessionsChanged` 事件。渲染器沿用现有的 `refreshSessions()` 权威列表刷新链，
Projects 页面也会据此刷新持久项目索引；插件不需要、也不应自行发送侧栏事件。
通过该 API 创建的项目不会自动打开为侧栏项目标签，以保留现有的已关闭项目行为。

主机限制每会话 2,000 条消息、每批 100 个会话、每条消息 512 KiB、每个工具值
256 KiB、每个 payload 32 MiB、JSON 深度 8。每个插件每分钟最多 10 次单条导入、
5 次批量导入和 20 次删除。写入前会移除工具 `__pi*` 与 `piDesktop.*` 对象键。
P2/P3（会话创建、消息变更、任意重新绑定、provider/model 绑定、批量删除、标签）不属于本次接口。

### agent.complete（需要 `agent.complete`）
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

宿主解析凭据，并通过与 Composer 提示增强相同的路径发起 `tools: []` 的一次性补全。
插件拿不到密钥。`includeSessionContext: true` 还需要 `session.read` 以及进行中的
工具会话。system ≤ 32 KiB；消息合计 ≤ 200k 字符；每个插件每滚动 60 秒 8 次
（`RATE_LIMITED`）；预算 90 秒（`TIMEOUT`）。

### 剪贴板/外壳
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

`openExternal` 解析 `url`，只打开 `http:`、`https:` 和 `mailto:`（D330 / ADR 0168）。
其他 scheme 以 `INVALID_ARGUMENT` 失败。

### browser（需要 `browser.cdp`）
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

访客页是宿主拥有的 `WebContentsView`（`persist:work-browser`）。
`setBounds` 相对调用插件视图的内容区，并被夹紧，因此访客页不能盖住聊天/输入框。
`cdp` 默认拒绝；cookie、storage、target 和网络拦截方法以 `PERMISSION_DENIED` 失败。
代理调用的会话身份来自进行中的 `plugins.execute` `sessionId`，而不是插件参数（D333 / ADR 0170）。

`getHistory` 返回由主机明确记录的条目，按最新优先排列，文本和图片按捕获时间混排。
通过 `writeText` 写入的内容，以及 Composer 用户主动粘贴事件提供的内容会被记录；主机
不会在后台轮询或重新读取系统剪贴板。连续相同内容会合并并刷新时间戳。历史只保留在
内存中，最多保留 30 天、500 条和 256 MiB；单条文本最多 100 KiB UTF-8 字节，图片
最多 50 MiB。图片统一返回 PNG 字节及像素尺寸。没有粘贴过的复制内容不会被记录。

### 服务（需要 `background.service`）
```ts
pi.services.register(service: {
 id: string // must match a contributes.services[].id
 start: (ctx: { log: (msg: string) => void }) => Promise<void> | void
 stop?: () => Promise<void> | void
}): void

pi.services.unregister(id: string): Promise<void>
```

注册是本地簿记：它记录处理程序，以便经纪人可以
打电话给他们。主机在卸载前调用 `onLoad` 和 `stop` 之后调用 `start`，并且
根据 [05-plugin-lifecycle.md](/zh-CN/spec/07-plugins/05-plugin-lifecycle) 重新启动崩溃的插件。
`start` 在一个进程内是幂等的——在已经运行的进程上进行第二次启动
服务是无操作的。

### 总线（需要 `bus.publish` / `bus.subscribe`）
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

`topic` 必须出现在 `contributes.bus.publish` 中； `pattern` 必须出现在
`contributes.bus.subscribe`。发布者被排除在自己的扇出之外。帽子
威胁模型位于 [04-plugin-security.md](/zh-CN/spec/07-plugins/04-plugin-security) §5.1 中。

### 网
```ts
pi.net.fetch(input: {
 url: string
 method?: string
 headers?: Record<string, string>
 body?: string
 timeoutMs?: number
}): Promise<{ status: number; headers: Record<string, string>; bodyText: string }>
```

### 桌面控制（需要 `desktop.control`）

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

这是第一方插件通往同一份已审查操作目录的网关，该目录也被可选启用的本地
MCP 控制平面使用（ADR 0203 / D370）。返回的目录省略 Electron 通道名，插件也
永远拿不到 MCP bearer token。调用复用控制器、IPC 处理器、生命周期检查、完成
事件和审计边界；插件无法触达任意 Electron IPC。

`dangerous` 操作（删除会话、更改权限模式、批准工具）需要两次答复。
`confirm: true` 是插件的知会，必须先给出（否则返回
`CONFIRMATION_REQUIRED`）。随后宿主在原生对话框中询问用户，对话框点名目录中
的操作 id、目录描述和一段参数预览；对话框绝不显示插件或模型撰写的文本，
因此一份被提示注入的转录本无法把 `session/delete` 重新包装成无害的东西。
对话框被关闭、被拒绝，或宿主没有对话框服务，都会在触达控制器之前以
`PERMISSION_DENIED` 失败。调用会连同插件 id、操作、风险等级和结果状态一起
记入日志；参数值不会复制进审计条目。

### 麦克风面板（需要 `ui.microphone`）

只有当清单声明且用户授予了 `ui.microphone` 时，隔离面板才可以通过浏览器
媒体 API 请求麦克风音频：

```ts
navigator.mediaDevices.getUserMedia({ audio: true })
```

宿主的权限处理器为该面板放行 `media` 权限，并继续拒绝摄像头和其他所有
设备权限。插件拿不到原生麦克风句柄或宿主密钥；浏览器的语音识别和语音合成
仍由页面持有。面板应提供文本回退，并通过其无障碍状态播报权限或识别失败。

## 4. 错误模型

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

所有 API 失败都会引发携带 `code` 的错误。

## 5. 事件（主机 -> 插件）

```ts
pi.events.on(event, handler)
pi.events.off(event, handler)
```

主机将事件作为单向帧推送到插件进程。今天交付：

- `bus.message` — 公交车交付，以 `PluginBusMessage` 作为单一
  论点。 `pi.bus.subscribe` 是接收这些信息的正常方式； `events.on`
查看插件持有的每个订阅的原始流。
- `workspace:changed` — 载荷为 `{ path: string; name: string } | null`，
  与 `workspace.get()` 一致，在缓存的工作区路径变化时发送。
- `plugin:settingsChanged`（由插件设置页面编辑触发）
- `session:modelChanged` — `{ sessionId, modelKey, thinkingLevel }`，在成功的
  `session.configure` 改变 provider、模型或 thinking level 之后发送

抛出的处理程序会被记录下来，并且不会影响其他侦听器或插件。

计划活动：
- `session:activated`
- `app:themeChanged` —— 目前面板通过面板事件 `appearance:changed` 实时跟随
  配色；插件进程侧的这个事件仍在规划中。

## 6. 面板桥 API

面板UI不直接获取完整的`pi`；相反：

```ts
window.pluginBridge.invoke(channel, payload?)
window.pluginBridge.on(event, handler)
```

同一个桥同时服务插件的两种表面：独立的 `ui.panel` 窗口，以及停靠在工作面板中的
`contributes.views` 表面（ADR 0104）。通道列表、权限门与 preload 完全相同，
因此同一份 HTML 入口在两种放置方式下都能工作。唯一的差别在于 chrome：停靠视图
没有窗口控制胶囊、没有拖拽带，其 `--pi-plugin-titlebar-height` 为 `0px` 而非
`46px`。

主机拥有的 preload 仅将固定通道转发到插件运行时：

| 频道 | 所需许可 |
|---|---|
| `ui.showToast`、`ui.closePanel` | 没有超出加载的面板 |
| `ui.notify` | `notify` |
| `ui.getNotificationPermission`、`ui.requestNotificationPermission`、`ui.showNativeNotification` | `notify` |
| `plugin.getSettings`、`workspace.get`、`app.getAppearance` | 无 |
| `models.list` | `models.list` |
| `fs.readText`、`fs.readPreview`、`fs.openDefault`、`fs.reveal`、`fs.glob`、`fs.list` | `fs.read` |
| `fs.writeText` | `fs.write` |
| `clipboard.readText`、`clipboard.getHistory` | `clipboard.read` |
| `clipboard.writeText` | `clipboard.write` |
| `shell.openExternal` | `shell.openExternal` |
| `net.fetch` | `net.fetch` |

`plugin.setSettings`、`fs.remove` 和任意 Electron IPC 未暴露。主机自己
没有实现的通道会被转发到插件的 `onPanelInvoke(channel, payload)`，
因此插件可以自定义面板 ↔ 主进程通道；没有导出 `onPanelInvoke` 的插件
会从自己的进程收到 `UNSUPPORTED`。主机支持的通道包括
`skill.list`、`skill.read`、`skill.create`、`skill.update`、`skill.remove`
和 `skill.setEnabled`。

### 面板事件（主机 -> 面板）

`window.pluginBridge.on(event, handler)` 接收主机推送的事件。宿主会把同样的
事件发给独立面板窗口和停靠的工作面板视图。今天已投递的事件：

- `appearance:changed` —— 载荷是上面的 `PluginAppearance`，在应用的配色或
  语言发生变化时发送，因此面板可以实时重新着色和重新标注文案。
- `workspace:changed` —— 载荷为 `{ path: string; name: string } | null`，
  与 `workspace.get()` 一致，在打开的项目变化时发送。

## 7. 通话审计

必须记录以下任何调用以供审核：

- fs.writeText
- fs.remove、fs.requestDirectory，以及每一次被拒绝的 fs 调用（连同路径与
  `errorCode`），还有每一次同意的答复及其被问的原因（`scope` / `rate`）
- fs.openDefault（记录 root-relative 路径以及系统打开是否成功）
- fs.reveal（记录 root-relative 路径以及文件管理器显示是否成功）
- fs.readPreview（记录 root-relative 路径以及分类后的 `kind`）
- 在agent.registerTool之后执行（包括从插件发现的工具）
  MCP 服务器）
- 网络获取
- shell.openExternal
- clipboard.read/write（可能是样品）
- clipboard.getHistory（记录返回的条目数）
-bus.publish/bus.subscribe/bus.unsubscribe（带有主题和扇出大小）
- browser.navigate / evaluate / cdp / openExternal
- 服务启动/停止/重新启动
- models.list（返回行数）
- session.getLlmContext（会话 id、消息数、truncated 标志 —— 不含转录文本）
- agent.complete（模型 key、体积、usage —— 不含提示或补全文本）

日志字段：
- 插件ID
- API
- TS
- 会话 ID？
- 好的/错误代码

## 8. 版本控制策略

- API 表面由 `apiVersion` 管理
- MVP `apiVersion = 1`
- 已弃用的 API 至少保留一个主要版本周期


## 9. 实施情况

桌面插件运行时现在实现本地和市场插件使用的 MVP 主机 API 表面：

- `app.*`、`plugin.*`、`commands.*`、`ui.*`、`workspace.*`
- `fs.readText` / `fs.readPreview` / `fs.openDefault` / `fs.reveal` /
  `fs.writeText` / `fs.glob` / `fs.list` / `fs.remove` / `fs.requestDirectory`，
  范围由 `manifest.fs` 限定（ADR 0088）
- `agent.registerTool` / `unregisterTool` / `agent.complete`
- `models.list`、`session.getLlmContext`
- `clipboard.*`、`shell.openExternal`、`net.fetch`
- `browser.*`（访客页 CDP；`browser.cdp`）
- `services.register` / `unregister`、`bus.publish` / `subscribe`、`events.on` / `off`

本机插件通知使用 Electron 主进程通知界面；
他们不会在任务通知收件箱中创建持久行，并且不会
单击激活会话。

声明性贡献没有故意与 `pi.*` 对应：技能、主题、
MCP 服务器由主机从清单中读取，因此插件无法添加
一个在运行时。

所有高风险入口点都会断言声明+授予的权限并发出审核日志行。
插件面板不再接收完整的 `pi` 对象；他们使用 `window.pluginBridge.invoke`。
