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
pi.app.setTheme(themeId: "system" | "light" | "dark" | `plugin:${string}`): Promise<void>
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
事件（见下文）上收到实时更新。插件进程通过 `pi.events` 收到同一事件。在没有该通道的
旧宿主上，调用以 `UNSUPPORTED` 拒绝；面板应回退到操作系统偏好和它自己的面板内选择。

`app.getLocale` 与 `getAppearance().locale` 是同一个语言标签。插件自有界面（面板、
视图、widget、设置入口、toast、运行时命令标题）据此自行本地化。宿主不再给更多贡献字段
加 `{ en, "zh-CN" }`；生成式 `contributes.settings` 标题保持作者语言纯字符串
（ADR 0280）。宿主拥有的身份文案（`manifest.i18n`）以及已经落地的 chrome 标签
（`ui.title`、视图标题、设置入口）仍走既有契约（ADR 0267、ADR 0082）。

`app.setTheme`（需要 `ui.theme`，ADR 0260）应用与设置选择器相同的
`AppSettings.theme`。接受内置偏好或当前已注册的插件主题 id；未知 id 以
`INVALID_ARGUMENT` 拒绝。宿主会持久化设置、刷新原生 chrome / 面板外观，
并向渲染进程发出 `settingsChanged`。

### 主题（需要 `ui.theme`）

调用方插件自有主题的运行时注册表。生产模式可用，无需卸载/重载（ADR 0260）。

```ts
pi.themes.upsert(input: {
  id: string;           // 本地 id，规则同 contributes.themes[].id
  label: string;
  base: "light" | "dark";
  css: string;          // 使用 sanitizeThemeCss 消毒
}): Promise<void>

pi.themes.remove(themeId: string): Promise<void>
pi.themes.list(): Promise<Array<{ id: string; themeId: string; label: string; base: "light" | "dark" }>>
```

- 完整 id 命名空间为 `plugin:<pluginId>:<themeId>`。
- 对已有 id 的 `upsert` 覆盖 label / base / css。
- 不再有单插件主题数量上限；CSS 体积上限与消毒器仍然生效。
- upsert/remove 后宿主发出 `pluginChanged`（`reason: "themes"`）并刷新面板外观，
  使**当前激活**主题立即重新着色。

### 插件
```ts
pi.plugin.getId(): string
pi.plugin.getManifest(): PluginManifestV1
pi.plugin.getSettings<T=Record<string, unknown>>(): Promise<T>
pi.plugin.setSettings(partial: Record<string, unknown>): Promise<void>
pi.plugin.getDataPath(): Promise<string> // plugin-private directory
```

插件页面会渲染 `contributes.settings` 中声明的字段，并将修改持久化到插件私有设置文件。
支持生成字符串、数字、布尔、枚举、JSON 和 `shortcut` 控件。生成式 `title` /
`description` / `enum[].label` 是作者语言纯字符串，宿主不会在这些字段上解析 locale
map。需要本地化设置页的插件应贡献 `settingsDestinations` 并读取 `pi.app.getLocale`
（ADR 0280）。快捷键仅属于插件域：只有在 PI-Desktop 窗口聚焦且插件激活范围匹配当前项目时，
才会调用声明的命令；本版本不会注册操作系统全局快捷键。用户编辑后，主机会向插件发送
`plugin:settingsChanged`，便于刷新内存中的配置。

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

### 语音（`speech.adapter.register`）
```ts
pi.speech.registerAdapter(adapter: {
  protocol: string
  label: string
  roles: Array<"transcribe" | "synthesize">
  handle: (input) => Promise<{ kind: "text"; text: string } | { kind: "audio"; mimeType: string; data: string } | { kind: "http"; call: SpeechHttpCall }>
}): Promise<void>
pi.speech.unregisterAdapter(protocol: string): Promise<void>
```

handle 留在插件进程。内置协议 id `openai_audio` 和 `openai_chat_audio` 保留。
HTTP 计划由宿主用绑定 provider 的密钥代发，且必须落在该 origin。


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
横幅而不更改持久任务通知收件箱。点击已交付的插件通知会恢复并聚焦主窗口，
但不会激活会话或创建持久任务通知。

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
pi.workspace.get(): Promise<{
  path: string;
  name: string;
  projectId?: string;
  roots?: Array<{ path: string; name: string; primary: boolean }>;
} | null>

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

`workspace.get` 回答主根——`path` 与其叶子 `name` 都保持不变——并在该文件夹属于某个项目组
（ADR 0249）时额外给出 `projectId` 与 `roots`：项目组按自身顺序登记的全部文件夹，主文件夹在前，
每项为 `{ path, name, primary }`（ADR 0263）。`workspace:changed` 携带同一对象，两者都由主机持有
的项目组记录回答，因此事件与主动拉取不会互相矛盾。无法解析项目组的主机会省略 `projectId` 与
`roots`，也就是插件本来就会处理的 `{ path, name }`；读取这些元数据不需要新权限，也不新增 SDK 方法。

`fs.readPreview` 为一份已存在且可读取的文件做应用内预览分类。它与 `fs.readText`
使用相同的 `fs.read` 检查，拒绝目录，并返回 `text`（上限 512 KiB）、`image`
（上限 5 MiB，data URL）、`binary` 或 `tooLarge`。插件不会收到绝对路径。

`fs.openDefault` 使用操作系统默认关联应用打开一个已存在的文件。它与
`fs.readText` 使用相同的 `fs.read` 根目录、符号链接、受保护路径、拒绝列表和范围检查；
目录会被拒绝。主机会记录这次操作。路径默认相对根目录；只有「本项目已注册的另一个文件夹根」
之内的绝对路径才会被接受，而且**只有这个动作与 `fs.reveal` 接受**（其他模式一律不接受
绝对路径），该根随即成为这次请求的包含基点（ADR 0249 §5、ADR 0264）——这正是视图用来指
名「非主文件夹里的文件」的形状。

`fs.reveal` 在操作系统文件管理器中显示一个已存在且可读取的文件，并在平台支持时选中它。
它使用相同的 `fs.read` 检查，拒绝目录，并记录成功和失败。路径的接受方式与 `fs.openDefault`
完全一致：默认相对根目录，落在本项目另一个已注册文件夹根之内时可以是绝对路径（ADR 0264）。

路径相对于该模式的 root —— 工作区，或者当该模式声明
`root: "userSelected"` 时，用户通过 `requestDirectory()` 选中的目录。
每种模式能到哪些路径由 `manifest.fs` 决定；范围之外会问用户，
而凭证 deny-list 压过两者（参见
[04-plugin-security.md](/zh-CN/spec/07-plugins/04-plugin-security) §6）。
`remove` 不递归，并且把路径移进系统回收站。
在 `workspace` 根下，路径相对于调用该调用的工具会话所属的项目，面板调用没有工具会话时
回退到可见工作区（ADR 0266）。

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

`turnId` 对宿主驱动的回合会被填充，并与对应的 `session:turnEnded` 事件（§5）的
`turnId` 一致。

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

### 用量（需要 `usage.read`）

面向用户仍可见的未删除会话，提供只读的**已完成回合事实行**。宿主只提供
每个 turn 一行的扁平事实——计数与标识符；绝不包含消息正文、转录投影或任何
写路径。**刻意不提供仪表盘形状**：连续天数、热力图、分模型占比、高消耗
排名都是插件在这些事实行之上自己的计算——日后调整指标口径也不会变成
SDK 的破坏性变更。

```ts
pi.usage.listTurns(input?: {
  fromMs?: number      // 含端点的窗口起点（epoch ms）；默认 toMs - 30 天
  toMs?: number        // 含端点的窗口终点（epoch ms）；默认当前时间
  projectId?: number | null
  sessionId?: string
  cursor?: string      // 上一次 nextCursor 返回的不透明分页游标
  limit?: number       // 1..=500 行；默认 200
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

语义：

- 只列出未删除会话的已完成 turn。用户删除的会话会从列表中消失。
- 行按 `endedAt` 升序 + keyset 游标排列，窗口填充时翻页依然稳定；仪表盘
  展示的排名是插件自己的排序，不是宿主的。
- 窗口跨度至多 365 天；`limit` 为 1..=500（默认 200）。Electron 侧先校验，
  宿主 RPC 边界按同样界限再次校验。缺省与 `null` 边界等价；空会话标题返回
  `null`。
- `usage_json` 缺失或畸形时 cache/reasoning 计数记 0——绝不返回残缺行。

### 会话协作（需要 `desktop.control`）

官方 Session Orchestrator 组合了已审查的 desktop-control 目录；这不是第二套 session API，
也不会暴露 Electron 通道或本地 MCP bearer token。

```ts
type SessionCollaborationOperation =
  | "session/collaboration/spawn"
  | "session/collaboration/send"
  | "session/collaboration/status"
  | "session/collaboration/result"
  | "session/collaboration/cancel"

// 所有调用均使用 pi.desktop.invoke({ operation, args: [input] })。
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
type StatusInput = { sessionId: string }
type ResultInput = { sessionId: string; messageId?: string; turnId?: string }
type CancelInput = { sessionId: string; messageId?: string }
```

`spawn` 返回真实持久目标 `sessionId` 和宿主投递 `messageId`。`send` 可以双向寻址已有
Session ID，并复用该会话的项目、模型、上下文和权限配置；`messageId` 只标识一条投递，
不是 worker 身份。`status` 和 `result` 是有界投影，不会加载完整转录本。`cancel` 只中断
精确的排队投递或绑定回合，并保留目标会话及其历史。

`spawn` 中显式指定的 `modelKey` 属于 AI 自动调度的模型选择，需要该模型自身的
`ModelBinding.availableForSubagents` 许可；对用户未勾选的模型，宿主在创建 worker 之前
返回 `PERMISSION_DENIED`。省略 `modelKey` 仍然是继承——先取已勾选的模型，否则取默认
模型——显式写出默认模型自己的键同样按继承处理，而不是一次选择
（ADR subagent-model-opt-in）。

`spawn` 和 `send` 仅在插件当前 Agent 工具调用期间有效。broker 注入 `pluginId`、来源
`sessionId`、来源 `turnId` 和调用身份；插件参数不能提供或覆盖这些字段。面向用户的插件
面板可使用自有插件身份调用 `cancel`，但不能用该路径发送或创建工作。宿主执行来源权限
上限、Agent 模式目标、收件箱和 worker 限制、幂等性以及有界自主跳数。请求的完成回调是
宿主拥有的 `completion` 消息，链接到源投递，并且只在实际目标回合结算后最多创建一次。
回调是会话数据，不是新的用户授权；完成消息不会触发另一个回调。

渲染器可以读取单独的侧边栏协作投影，但插件面板不能绕过此网关调用变更操作。

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

`fetch` 原样返回上游响应 —— `status`、`headers`、`bodyText` —— 所以 `429`
是插件能读到的数据（`Retry-After` 也在里面），而不是被主机藏起来的错误。宿主
不重试、不限流、也不重新发起请求：遇到 `429` 之后的重试与退避是插件自己的
策略，响应头就是插件唯一能拿到的退避信号。失败的调用（`status >= 400`）在
审计里记为 `ok: false`，并在响应声明了延迟时附带它通告的 `retryAfter`（§7）。

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

需要 `net.websocket`。`connect` 会和 `fetch` 一样被严格限制在
`manifest.net.domains` 之内，`connect` / `close` 会记入审计。帧以宿主事件的
形式到达：`net:websocket:open`、`net:websocket:message`、`net:websocket:close`、
`net:websocket:error`，每个都带着持有它的 `socketId`，用 `pi.events.on` 订阅。
只有持有该套接字的那个插件会收到它们。

套接字由宿主持有，所以插件不能超过四个套接字，不能发送或接收大于 1 MiB 的帧，
也不能排队超过 4 MiB 的未发送数据；每一种都会被拒绝（`LIMIT_EXCEEDED`），或者
直接关闭连接，而不是让宿主的内存继续增长。一次 connect 会带上 `headers` 与
`protocols`，所以按连接认证的端点无需把凭证暴露给插件代码。拒绝会说明原因：
非 `ws(s)` 的 URL 或畸形的协议令牌是 `INVALID_ARGUMENT`，握手没有完成是
`TIMEOUT`，握手失败是 `CONNECT_FAILED`，套接字不属于该插件是 `NOT_FOUND`，
主机不在白名单内是 `PERMISSION_DENIED`。

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

这是第一方插件通往与可选启用的本地 MCP 控制平面共用同一份已审查操作目录的
网关（ADR 0203 / D370）。两份目录的差异仅在于标记为 plugin-only 的操作：六个
`session/collaboration/*` 操作可以通过该网关调用，却被刻意排除在 MCP 可见目录
之外（`tools/list`、`pi_control_describe` 以及 `pi_desktop_invoke` 的枚举），
因为它们需要已认证的插件调用上下文，且渲染器没有任何变更通道。返回的目录省略
Electron 通道名，插件也永远拿不到 MCP bearer token。调用复用控制器、IPC 处理器、
生命周期检查、完成事件和审计边界；插件无法触达任意 Electron IPC。

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

### 音频（需要 `audio.capture.background` / `audio.playback.background`）

**可以调用，但本条分支尚未实现设备后端。** `pi.audio` 存在于插件宿主进程
中，恰好暴露下面这十个方法。每个方法都保留自己的权限要求：六个采集方法
（`getInputDevices`、`openInput`、`closeInput`、`getCaptureState`、
`onInputFrame`、`offInputFrame`）需要 `audio.capture.background`，四个播放
方法（`openOutput`、`writeOutput`、`stopOutput`、`closeOutput`）需要
`audio.playback.background`。没有授权时调用会被拒绝为 `PERMISSION_DENIED`，
并按权限名记入审计，与其他所有需要把关的 API 完全一致。拿到授权后宿主仍然
没有设备后端，所以每次调用都会以带错误码的 `UNSUPPORTED` 拒绝：消息是
`host api not available: audio.<method>`，审计条目是
`{ api: "audio.<method>", ok: false, errorCode: "UNSUPPORTED" }`。八个异步
方法用这个错误拒绝；`onInputFrame` / `offInputFrame` 是无法 reject 的同步
注册辅助函数，因此它们直接抛出带同一个 `code: "UNSUPPORTED"` 的 `Error`，
而不是注册一个永远不会触发的处理器。不会有任何东西接触设备，也不会产生
任何帧。`onInputFrame` 是注册回调 —— 它不是事件名 —— 帧形状见
`packages/plugin-sdk/src/index.ts` 中的 `PluginAudioInputFrame`。等设备服务
落地后，权限和这个表面都保持不变，只有拒绝会被真实行为取代：设备由宿主
持有，插件只交换 PCM16 帧，永远拿不到设备句柄、`MediaStream`、操作系统
设备路径或 Node 流，每个插件只允许一条输入流，禁用、卸载或崩溃会停止采集
并丢弃已排队的播放。

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

### 键盘（需要 `keyboard.globalShortcut`）

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

宿主 —— 而不是插件 —— 持有 Electron 的 `globalShortcut`。插件把一个加速键
映射到自己的一条命令，由宿主完成注册、冲突检查、触发和释放；插件永远
拿不到键盘钩子、`before-input-event`、原始输入设备或按键事件流，一次触发
也只是属于该插件的一条命令。

`command` 必须已经由调用插件注册；否则以 `INVALID_ARGUMENT` 失败。被操作
系统保留、被 PI-Desktop 自己当前占用（默认 `Alt+Space` 打开插件启动器、
`Alt+Shift+W` 呼出或隐藏窗口；用户改绑后释放出来的加速键可以再次被插件使用）或
已被另一个插件持有的加速键会被拒绝而不是被抢走，被拒绝的重新注册会保留原来
的绑定。拒绝是返回的结果，不是抛出的异常：
`registerGlobalShortcut` 以 `registered: false` 解析，并带 `error` 为
`SHORTCUT_CONFLICT`、`SHORTCUT_UNAVAILABLE`（平台拒绝）、
`INVALID_ACCELERATOR` 或 `LIMIT_EXCEEDED`（每个插件最多 8 条）。
`UNSUPPORTED` 和 `INVALID_ARGUMENT` 会抛出。用同一个 `id` 再次注册会替换
该条目的加速键。

每条带 `default` 的 `contributes.globalShortcuts` 条目会在插件加载后由宿主
注册，但仅当它的命令确实注册成功；没有 `default` 的条目等待
`registerGlobalShortcut` 调用。`unregisterGlobalShortcut` 删除一条条目，
未知 id 时什么都不做；`listGlobalShortcuts` 列出宿主当前为调用插件持有的
条目。禁用、卸载和崩溃时全部释放，注册 / 注销都会记入审计。

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
- `workspace:changed` —— 载荷是 `workspace.get()` 的对象或 `null`，在缓存的工作区路径变化时发送：
  主文件夹的 `path` 与 `name`，以及在该文件夹属于某个项目组时的 `projectId` 与 `roots`（ADR 0263）。
  一次运行中的第一个工作区可能先不带文件夹发送一次、再带文件夹重发一次，因为项目组记录是在那次推送
  之后才读取的。
- `plugin:settingsChanged`（由插件设置页面编辑触发）
- `appearance:changed` —— 载荷是 `PluginAppearance`，在应用配色或语言变化时发送，
  因此插件进程可以像打开的面板一样实时重标文案（ADR 0280）。
- `session:modelChanged` — `{ sessionId, modelKey, thinkingLevel }`，在成功的
  `session.configure` 改变 provider、模型或 thinking level 之后发送
- `session:turnEnded` —— 载荷为
  `{ sessionId: string; turnId: string; reason: "completed" | "aborted" | "error" }`，
  在每个宿主回合的拆除结束时发送一次，位于持久化的 `session.endTurn` 尝试之后。
  “回合”指 `session.beginTurn` 创建的那个回合：一次用户提交、一次已批准的计划执行、
  或一次定时运行；排队但从未开始的项目不会产生事件。`completed`、`aborted`、`error`
  是三种终止原因。事件携带终止运行时事件本身标识的 `turnId`，而不是恰好处于活动
  状态的那个回合，因此来自更早回合的迟到事件不会结算更新的回合。投递是
  即发即忘：没有 ack，也没有重放，因此存活的已订阅插件只收到一次；与插件崩溃、
  重载或宿主退出竞态的投递不作保证。收到该事件**并不**意味着该回合的所有在途
  工具都已退出——迟到结果仍可能到达——因此插件必须按 `turnId` 串行化或以其他方式
  限定清理范围。该事件同样不需要新权限：它走既有的插件事件通道，订阅未知的事件名
  也不会报错。目前尚无任何已发布宿主会发出该事件（0.14.8 也尚未包含），因此依赖它
  的插件必须按真正包含该事件的发布版本要求，而不能假定 0.14.7 或 0.14.8。

抛出的处理程序会被记录下来，并且不会影响其他侦听器或插件。

计划活动：
- `session:activated`

## 6. 面板桥 API

面板UI不直接获取完整的`pi`；相反：

```ts
window.pluginBridge.invoke(channel, payload?)
window.pluginBridge.on(event, handler)
```

同一个桥同时服务插件的两种表面：独立的 `ui.panel` 窗口，以及停靠在工作面板中的
`contributes.views` 表面（ADR 0104）。通道列表、权限门与 preload 完全相同，
因此同一份 HTML 入口在两种放置方式下都能工作。差别只在于 chrome 与下面这个
视图 `location`：停靠视图没有窗口控制胶囊、没有拖拽带，其
`--pi-plugin-titlebar-height` 为 `0px` 而非 `46px`。

停靠视图还可以被指定一个要展示的对象。工作面板选项卡本来就携带的 `location`
会投递给任何贡献视图——不再只限 `pi.browser`（它的地址栏保留自己的导航通道）：
创建时它作为视图入口 URL 的 `piViewOpen` 查询参数传递，文档加载完成后则通过
`view:open` 事件送达。在首次加载之前到达的 location 改为重启这次加载；已加载的
视图永远不会被导航，因此插件里未保存的改动不会被丢弃，重复打开同一个 location
什么也不做。该载荷对主机是不透明的——每个插件自行决定 `location` 的含义——它
不需要新权限，也不新增 SDK 方法。

主机拥有的 preload 仅将固定通道转发到插件运行时：

| 频道 | 所需许可 |
|---|---|
| `ui.showToast`、`ui.closePanel` | 没有超出加载的面板 |
| `ui.notify` | `notify` |
| `ui.getNotificationPermission`、`ui.requestNotificationPermission`、`ui.showNativeNotification` | `notify` |
| `plugin.getSettings`、`workspace.get`、`app.getAppearance` | 无 |
| `app.setTheme`、`themes.upsert`、`themes.remove`、`themes.list` | `ui.theme` |
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
- `workspace:changed` —— 载荷是 `workspace.get()` 的对象或 `null`，在打开的项目变化时发送：
  主文件夹的 `path` 与 `name`，以及在该文件夹属于某个项目组时的 `projectId` 与 `roots`（ADR 0263）。
- `view:open`（仅限停靠的工作面板视图；独立 `ui.panel` 窗口不会收到）——载荷为
  `{ path: string }`，即主机要求该视图展示的 location。创建时就带 location 的视图
  已经从入口 URL 拿到它；这个事件投递的是之后的 location。
- `session:turnEnded` —— 与 §5 的插件进程事件同一载荷，在宿主回合到达终止状态
  时发送。

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
- status / retryAfter（仅 `net.fetch`：已完成调用的上游状态码，以及失败调用所
  声明的 `Retry-After` —— 绝不记录整个头部集合或响应体）

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
- `speech.registerAdapter` / `unregisterAdapter`（`speech.adapter.register`）

- `models.list`、`session.getLlmContext`
- `clipboard.*`、`shell.openExternal`、`net.fetch`
- `browser.*`（访客页 CDP；`browser.cdp`）
- `services.register` / `unregister`、`bus.publish` / `subscribe`、`events.on` / `off`
- `keyboard.registerGlobalShortcut` / `unregisterGlobalShortcut` / `listGlobalShortcuts`
  （`keyboard.globalShortcut`；Electron 的 `globalShortcut` 由宿主持有）
- `net.websocket.connect` / `send` / `close`（`net.websocket`；套接字由宿主
  持有，受白名单限制，有界，随插件一起释放）

`pi.audio.*` 已存在于插件宿主进程中并且可以调用：十个方法都由
`audio.capture.background` / `audio.playback.background` 把关，而这条分支没有
设备后端，所以获得授权的调用会以带错误码的 `UNSUPPORTED` 拒绝，并记入该方法
自己的审计条目（`audio.<method>`、`ok: false`）；`onInputFrame` /
`offInputFrame` 无法 reject，因此同步抛出同一个错误码。不会打开任何设备。

本机插件通知使用 Electron 主进程通知界面；
他们不会在任务通知收件箱中创建持久行，并且不会
单击激活会话。

声明性贡献没有故意与 `pi.*` 对应：技能、主题、
MCP 服务器由主机从清单中读取，因此插件无法添加
一个在运行时。

所有高风险入口点都会断言声明+授予的权限并发出审核日志行。
插件面板不再接收完整的 `pi` 对象；他们使用 `window.pluginBridge.invoke`。
