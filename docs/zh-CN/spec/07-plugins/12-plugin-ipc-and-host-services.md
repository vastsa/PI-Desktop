# 12. 插件 IPC 和主机服务

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/12-plugin-ipc-and-host-services) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 目标

完成与插件相关的主机服务和 UI IPC，以便实现不依赖于临时约定。

## 2. 主进程服务

下图是职责划分示意，并非导出类的清单。`PluginRuntime` 在
`apps/desktop/electron/main/plugin-runtime.ts` 中实现调用代理与贡献注册表；
`ipc/plugin-ipc.ts`、`ipc/plugin-ui-ipc.ts` 和 `ipc/market-ipc.ts` 注册面向应用渲染进程的
处理器。Rust host-core 在 `crates/host-core/src/plugins/` 中负责插件注册信息的持久化、
安装和插件市场操作。

```text
PluginManager
 ├─ PluginRegistryStore
 ├─ ManifestValidator
 ├─ PackageInstaller
 ├─ PermissionGateway
 ├─ ContributionRegistry
 │ ├─ CommandRegistry
 │ ├─ AgentToolRegistry
 │ ├─ SkillRegistry
 │ ├─ ThemeRegistry
 │ └─ McpServerRegistry
 ├─ PluginRuntimeBroker
 │ ├─ ServiceSupervisor
 │ └─ MessageBus
 ├─ PluginPanelHostService
 └─ MarketClient
```

## 3. UI IPC（添加）

以下为 `packages/shared/src/protocol.ts` 中 `IPC.invoke` 定义的应用渲染进程调用通道，
均省略公共前缀 `pi-desktop/`。它们不同于插件进程 API 和面板桥接通道。
实际可调用的接口以处理器注册代码为准，而非上面的概念性服务划分。

### 插件域
- `plugin/list`
- `plugin/rendererCall`
- `plugin/composerTransform`
- `plugin/importExtension`
- `plugin/loadDev` — 打开文件夹选择器，并返回该目录声明的权限供用户审核；此时尚未注册或加载插件
- `plugin/loadDevConfirm` — 确认审核结果：注册开发插件目录，按用户批准的权限加载，
  并将本次授权作为后续热重载的权限上限
- `plugin/reload` — 解析已注册的插件路径，将清单与已有授权比较；若新增权限或扩大文件访问范围，
  则返回审核信息，否则直接在 Electron 主进程中重新加载
- `plugin/reloadConfirm` — 确认审核结果：按用户批准的权限重新加载，并更新开发插件的权限上限
- `plugin/createFromTemplate` — 生成脚手架文件，并返回相同的加载审核信息；生成文件本身不授予加载权限
- `plugin/installFromPath` ✅
- `plugin/installFromPackage` ✅
- `plugin/enable`
- `plugin/disable`
- `plugin/setScope`
- `plugin/uninstall`
- `plugin/settings/get`
- `plugin/settings/set`
- `plugin/openPanel`
- `plugin/setAutoUpdate`
- `plugin/themes` ✅ — 已加载插件经安全过滤的主题 CSS，供主题选择器和注入的 `<style>` 元素使用
- `plugin/providerCatalog`
- `plugin/scenicThemes/destinations`
- `plugin/scenicThemes/setBlur`
- `plugin/services` ✅ — 常驻服务状态（`starting` | `running` | `stopped` | `failed`）
  及重启次数，供插件页的状态标签显示
- `plugin/views`
- `plugin/view/open`
- `plugin/view/close`
- `plugin/view/setBounds`
- `plugin/view/setVisible`
- `plugin/session/active`
- `plugin/composer/suggestionResult`

`plugin/list` 返回插件详情及声明的权限；本域没有专用的详情、日志、权限授予/撤销或
目录打开通道。插件启动器使用独立的 `pluginLauncher/toggle` 和 `pluginLauncher/dismiss` 通道。

### commandPalette 域
- `commandPalette/search`
- `commandPalette/execute`

搜索结果合并内置命令、在当前项目中激活的插件命令，以及受信任扩展命令。
执行时会再次校验插件的激活范围。内置命令返回确认结果，由渲染进程继续处理；
受信任扩展命令通过 `extensions/commands/run` 在指定会话中执行，
不使用 `commandPalette/execute`。

### 市场域（已实现）
- `market/refresh`
- `market/search`
- `market/getDetail`
- `market/install`
- `market/checkUpdates`
- `market/applyUpdates`
- `market/cancelInstall`
- `market/reviewSummaries`
- `market/reviewTickers`
- `market/reviews`

当前没有用于枚举插件市场源的调用通道。搜索、详情、安装、更新、取消及匿名评论读取
均通过 `ipc/market-ipc.ts` 委托给 host-core 执行。

## 4. 事件（主 → 渲染器）

- `IPC.event.pluginChanged` — `pi-desktop/event/pluginChanged`
- `IPC.event.pluginInstallProgress` — `pi-desktop/plugin/event/installProgress`
- `IPC.event.pluginViewReveal` — `pi-desktop/plugin/view/event/reveal`
- `IPC.event.pluginComposerSuggestion` — `pi-desktop/plugin/composer/event/suggestion`
- `IPC.event.toast` — `pi-desktop/app/event/toast`，包括运行时崩溃和开发插件重载的反馈

`IPC.event` 中没有独立的加载错误、权限审核请求或可用更新事件。开发插件的权限审核信息
通过调用结果返回；更新发现结果由 `market/checkUpdates` 返回。安装和更新进度则从
host-core 的 `plugin.installProgress` 通知转发而来。

当前实现的 `pluginChanged` 事件携带 `reason`，供渲染进程决定需要重新获取哪些数据。
取值包括 `install`、`loadDev`、`reload`、`settings`、`scope`、`enable`、`disable`、
`uninstall`、`crash`、`service`、`restore`、`market.install`、`market.applyUpdates` 和
`themes`（运行时 `themes.upsert` / `themes.remove` / `themes.setVariables`）。
`service` 在服务监管状态变化时触发，只需刷新服务列表，开销较小。`restore` 在启动恢复
加载完已启用的插件后触发一次，使此前已读取列表的界面也能获取恢复后的插件。

`settingsChanged`（`pi-desktop/app/event/settingsChanged`）在**宿主**绕过渲染进程路径
修改应用设置时携带设置补丁；当前用于插件 `app.setTheme`（`{ theme }`）。
渲染进程将补丁合并到状态存储，使应用界面呈现新的主题偏好。

面板桥接的固定通道还包括 `app.setTheme`、`themes.upsert`、`themes.remove`、
`themes.list` 和 `themes.setVariables`，均需要 `ui.theme`。
`projects.list` 只提供项目元数据，不需要权限，也不会授予文件或会话访问权限。

## 4.1 事件（主机→插件进程）

调用代理还会向插件的 `utilityProcess` 推送单向消息帧：

```text
{ t: "event", event: "bus.message", subscriptionId, message }
```

该通道不发送回复帧，也不施加背压：发送方不等待处理结果，因此订阅方停滞不会阻塞
发布方。插件子进程将消息分发给 `subscriptionId` 对应的处理器，以及通过
`pi.events.on` 注册的监听器。处理器同步抛出的异常会被记录，不会终止插件进程。
`pi.events.on` / `off` 使用的就是这一通道（参见
[03-plugin-api.md](/zh-CN/spec/07-plugins/03-plugin-api) §5）。

## 5. ContributionRegistry 行为

### 注册
- 命令 ID 按原值保存，约定使用 `plugin.<pluginId>.<commandId>` 形式；调用代理
  不会自动添加或校验该命名空间。注册其他插件已占用的命令 ID 时，宿主返回
  `CONFLICT` 错误；注销其他插件的命令时，宿主返回 `PERMISSION_DENIED` 错误。
  插件仍可更新自己的命令，也可注销不存在的 ID。
- 插件工具前缀策略：`plugin_<pluginIdSafe>_<toolName>`（在实现中修复）

### 查询
- 命令面板仅查询已启用+加载成功的贡献
- Agent 可使用已注册工具；Plan/Goal 仅暴露运行时 `planSafeActions` 非空的工具，
  执行时再次校验 `args.action` 是否在允许列表中

### 注销
- 禁用、卸载或移除插件时清理其全部贡献，包括停止常驻服务、断开 MCP 连接、
  移除总线订阅，以及从主题选择器中移除插件主题

## 6. RuntimeBroker 调用链

`plugin.session.autoTitleContext` 和 `plugin.session.setAutoTitle` 属于
`session.autoTitle` 权限管控的白名单能力。前者只读取默认标题会话的有界首轮文本；后者
在 Rust host-core 内通过精确标题 CAS 更新。它们不复用插件拥有会话的转录读取 API。

插件调用宿主 API：

```text
plugin utilityProcess: pi.<namespace>.<method>(...args)
 → { t: "call", id, api, args, invocationId? } to Electron main
 → PluginRuntime.handleChildMessage → dispatchHostCall
 → API-specific validation and permission checks
 → host API / injected host service (audit where implemented)
 → { t: "res", id, ok, value } or { t: "res", id, ok: false, error }
 → resolve/reject the plugin's pending promise
```

反向调用通过 `sendToChild` 执行初始化、生命周期钩子、命令、工具和插件回调。
面板通过 preload 调用 `pi-plugin-panel-invoke`；内置桥接通道在主进程中执行，
自定义通道则以 `panel.invoke` 转发给插件的 `onPanelInvoke`，超时预算为 30 秒。

### 6.1 实时能力的白名单名称与审计操作

调用代理的 `HOST_API_ALLOWLIST` 包含以下三个已实现的条目，均受
`keyboard.globalShortcut` 把关：

- `keyboard.registerGlobalShortcut`
- `keyboard.unregisterGlobalShortcut`
- `keyboard.listGlobalShortcuts`

对应的审计操作是 `keyboard.globalShortcut.register`、
`keyboard.globalShortcut.unregister` 和 `keyboard.globalShortcut.trigger`
（快捷键触发）。注册操作记录快捷键组合与命令，触发操作记录命令；不记录原始按键事件或输入文本。

套接字能力已实现：`net.websocket.connect` / `net.websocket.send` /
`net.websocket.close` 已注册进同一份白名单，由 `net.websocket` 把关。它的审计
操作是 `net.websocket.connect` 与 `net.websocket.close`（记录插件 id 与结果，
从不记录载荷、请求头或密钥），外加被拒绝的 `net.websocket.send`；成功的
`send` 不记入审计。帧只回到持有它的插件，以宿主事件 `net:websocket:open`、
`net:websocket:message`、`net:websocket:close` 和 `net:websocket:error` 的形式送达。

音频能力的名字已注册进同一份白名单：`audio.getInputDevices`、
`audio.openInput`、`audio.closeInput`、`audio.getCaptureState`、
`audio.onInputFrame`、`audio.offInputFrame`、`audio.openOutput`、
`audio.writeOutput`、`audio.stopOutput` 和 `audio.closeOutput`。对于到达宿主调用代理的请求，
权限检查先执行：
没有授权的调用会与其他任何需要把关的 API 一样，以 `PERMISSION_DENIED` 拒绝，
并归到 `audio.capture.background` / `audio.playback.background` 名下。当前宿主
还没有设备后端，所以每个通过把关的调用都会作为 `UNSUPPORTED` 拒绝记入审计 ——
`{ api: "audio.<method>", ok: false, errorCode: "UNSUPPORTED" }` —— 并以该错误码
拒绝。插件进程中的 `audio.onInputFrame` / `audio.offInputFrame` 则在本地同步抛出
`UNSUPPORTED`，不会发送宿主请求、执行宿主权限检查或生成宿主审计记录。
为设备服务预留的审计操作名：`audio.input.open` / `audio.input.close`、
`audio.output.open` / `audio.output.stop` / `audio.output.close`（ADR 0257）。

## 7. PanelHost交互

- 打开面板时创建独立视图
- 传入pluginId /主题令牌
- 关闭时销毁视图和消息订阅。需要 `webContents` 身份的清理必须在窗口销毁前复制该 id；`closed` 处理程序不得在已销毁的窗口上读取 `webContents`，否则宿主会抛出未捕获的 `TypeError: Object has been destroyed`。
- 桥接身份绑定到页面，而非当前打开的面板列表：独立面板和停靠视图在加载文档前注册所属插件，
  直到页面销毁后才释放。因此关闭过程中到达的调用仍能路由到该页面所属的插件。
  若发送页面已经销毁，则直接完成调用而不再派发或报错，因为页面已无法读取结果，
  插件运行时也可能正在退出；否则只会在主进程日志中产生无意义的 `invalid panel invoker` 错误。
  应用关闭时会先在限定时间内关闭面板和视图页面，再执行 `plugins.disposeAll()` 与 `host.dispose()`。
- preload 通过 `pluginBridge.getDroppedFilePath(file)` 暴露文件路径，但不向页面暴露 Node。面板可以把路径传给 `fs.registerDropped`；宿主会一次性消费发送方最近的拖拽记录，为 `fs.stat` / `fs.readRange` 签发单文件读取授权。

面板桥接文件通道的权限如下：

| 通道 | 所需权限 |
|---|---|
| `fs.readText`、`fs.stat`、`fs.readRange`、`fs.readPreview`、`fs.openDefault`、`fs.openInBrowser`、`fs.reveal`、`fs.glob`、`fs.list`、`fs.requestDirectory` | `fs.read` |
| `fs.registerDropped` | `fs.read` 加真实拖拽手势 |
| `fs.writeText` | `fs.write` |

## 8. 故障隔离

- 宿主发往插件的请求超出 `sendToChild` 预算时，以 `TIMEOUT` 拒绝，并发送取消消息帧。
  插件调用宿主的代理层没有统一超时，由各宿主 API 分别控制执行预算。
- 初始化失败会卸载插件，并记录 `plugin.load.error`。插件进程意外退出会移除运行中的插件
  及其贡献；该路径不会将持久化注册记录的状态改为 `load_error`。
- 面板渲染与插件进程相互隔离。面板和视图宿主没有通过 `render-process-gone` 处理器
  自动关闭或重载崩溃页面。面板的首次加载另有 15 秒时限，超时以 `PANEL_LOAD_TIMEOUT`
  拒绝，并销毁尚未显示的窗口。

**当前实现（2026-07-29，ADR 0008）：** 调用代理位于
`apps/desktop/electron/main/plugin-runtime.ts`。每个插件的主模块运行在独立的
`utilityProcess` 中；插件对宿主 API 的调用会回到主进程中的调用代理。
宿主发往插件的请求预算分别为：加载 15 秒、生命周期钩子 5 秒、命令 30 秒、工具 110 秒
（小于 host-core 默认的 150 秒调度预算）。应用关闭时，卸载钩子的预算为 1.5 秒，
全部插件清理的总预算为 3 秒。插件进程意外退出时，调用代理以 `PLUGIN_CRASHED`
拒绝待完成的调用，注销该插件的命令和工具，关闭面板，写入 `plugin.crash` 审计记录，
并向渲染进程发送 Toast 通知和 `pluginChanged` 事件。声明的常驻服务可能按有界退避策略
自动重启。

## 9. 验收

1.插件列表IPC有效
2.命令面板IPC可以执行插件命令
3. Start/stop 触发贡献 registration/deregistration
4. 已实现的插件市场 IPC 委托 host-core 执行；安装和更新后刷新已启用的插件，
   取消结果与进度反映宿主操作的实际状态

标题插件在 Electron 调用代理校验 `session.autoTitle` 后，使用以下两个范围受限的插件会话 RPC：

- `plugin.session.autoTitleContext` 仅返回首条用户消息与首条助手回复，分别限制字符数，
  且只允许读取 `title_source` 为 `default` 的会话。
- `plugin.session.setAutoTitle` 校验标题，并且仅在预期标题与 `default` 来源仍匹配时更新。
  更新成功后触发常规的宿主 `sessionsChanged` 事件。

这些方法是 host RPC 协议 v11 的增量接口，不授予 `plugin.session.listMessages`
或一般会话转录内容的访问权限。

## 附录：代理工具调度协议（M5实现）

插件的 Agent 工具在桌面执行器（Electron 主进程）中运行，权限检查和返回结果封装
仍由 host-core 负责：

1. 模型调用 `plugin_<pluginIdSafe>_<toolName>`；sidecar 与处理内置工具一样，
   将请求转发给宿主的 `tools.execute`。
2. host-core 首先读取持久化的运行模式。在 Agent 模式下，执行
   常规权限流程（风险等级、会话授权、无自动审批截止时间），然后发出
   通知 `plugins.execute`
   `{ executionId, sessionId, toolCallId, toolName, args, turnId }`。`turnId` 是
   运行时回合身份，原样转发，以便插件工具上下文能与
   `session:turnEnded` 事件对应。
3. Plan/Goal 未声明 `planSafeActions` 时在宿主策略门拒绝；已允许的调用携带模式和操作列表，
   桌面插件执行器在进入插件代码前拒绝缺失或未列出的 `args.action`。Agent 使用正常权限流程。
   Electron 通过 `plugins.resolveExecution` `{ executionId, ok, content, errorCode? }` 返回。
4. host-core 完成待处理的执行请求，并向 sidecar 返回标准的
   `ToolsExecuteResult`。默认调度预算为 150 秒
   （`DESKTOP_TOOL_DISPATCH_TIMEOUT_MS`，高于 110 秒的插件工具预算，也高于最宽的
   MCP 调用链：10 秒惰性握手 + 30 秒 `tools/list` 遍历 + 100 秒调用）；
   显式传入的工具 `timeoutMs` 会覆盖该默认值。调度超时映射为 `TOOL_TIMEOUT`，
   未知或已卸载的工具映射为 `TOOL_NOT_FOUND`。
   等待明确权限决定时，`tools.execute` 传输没有截止时间；批准后仍以 host-core 的工具
   执行预算为准。

每次构建提示时，主进程都会将已注册的插件工具定义（`fullName`、描述及 JSON Schema 参数）
传给 `agent.prompt`。运行时将其保存在按需加载的工具目录中，不会在首次请求中序列化
全部工具 Schema。模型通过本地 `ToolSearch` 查找并加载匹配的插件工具，后续回合接收
所选工具的 Schema，再沿用上述宿主权限检查与调度路径。
对应验证场景为协议冒烟测试 E2E-024 和运行时加载测试 E2E-008a。

从插件的 MCP 服务器发现的工具会进入相同的注册表
`plugin_<pluginIdSafe>_<serverId>_<toolName>`，所以上面的步骤1-4不变；
只有步骤 3 内部有所不同，转发到 MCP 客户端而不是插件 JS。

技能采用独立且更简单的路径。基础系统提示中包含技能目录（id、名称、描述），
`Skill` 工具的 Schema 本身也需通过 `ToolSearch` 按需加载。
Electron 主进程提供本地 `Skill` 工具，读取技能文档并将正文作为本地工具结果返回；
技能目录不会将全部正文预先加载到模型上下文。只有模型请求时，技能文档才会进入上下文
（D174/D185）。加载结果包含 `SKILL.md` 的绝对路径及其父目录说明，
因此 `references/foo.md`、`SECRET.md` 等相对引用都以实际加载的文档为基准解析。
技能目录保持不变，不携带路径元数据。
