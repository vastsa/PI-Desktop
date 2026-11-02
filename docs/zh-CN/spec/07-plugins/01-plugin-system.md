# 01. 插件系统

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/01-plugin-system) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 0. 冻结实现默认值

- 插件工具公开名称使用强制前缀 `plugin_<pluginIdSafe>_<toolName>` (D015)
- 启用→加载失败自动禁用插件（D017）
- 卸载默认删除插件数据（D016）
- MVP (D018) 中不允许使用插件设置机密
- 运行时目标仍然是单独的进程； M4 可以使用主机管理的沙盒运行时 (D009)
- 每个扩展都带有 `enabled` 和激活范围；插件以及用户自己的 MCP 服务器和技能均可设为
  全局生效或仅在指定项目中生效（D192）
- 用户 MCP 工具使用前缀 `mcp_<serverId>_<toolName>`，与 D015 的插件命名空间互不重叠（D193）

插件工具默认在 Plan/Goal 中隐藏并拒绝。运行时工具注册可通过非空 `planSafeActions`
显式加入，只有 `args.action` 位于该列表时才允许执行。有 schema action enum 时会校验取值。
清单描述符应与运行时注册保持一致，真正执行的工具由运行时注册决定。
`risk: "low"`、会话授权和 `auto` 不能代替该声明。宿主策略与插件执行器都会校验，
执行器对越界 action 返回 `PERMISSION_DENIED`。该列表是作者的只读承诺，不是副作用沙盒（ADR 0211）。

## 1. 目标

为 PI-Desktop 提供类似于已建立的桌面插件生态系统的可扩展性（例如 VS Code 扩展）：

- 用户可以安装/启用/禁用/卸载插件
- 开发人员可以构建自定义插件
- 插件可以扩展命令、面板、工具和 Agent 功能
- 平台保持安全边界，不会将完整的系统权限直接交给任意第三方代码

用一句话来说：

> **PI-Desktop 是宿主，插件是能力包。**

## 2. 设计目标

### 从已建立的插件生态系统中采用的模式
- 基于目录的插件安装
- 在清单文件中声明的功能
- 功能关键字/命令触发器
- 专门的插件管理页面
- 用于加载本地插件的开发者模式

### 差异（因为我们是 Agent 桌面）
- 插件不仅仅是小型实用面板；他们还可以扩展：
 - Agent 工具
 - 技能
 - MCP 桥
 - 会话命令
 - 设置
- 高风险能力必须经过权限框架
- 宿主 API 需要声明与授权；插件主进程的原始 Node 代码仍以用户权限运行，隔离面板没有 Node 集成

## 3. 插件可以做什么

### MVP-Plugin 范围（插件系统的第一次迭代）
1. **命令插件**：注册命令面板操作
2. **面板插件**：打开插件UI面板（iframe / webview沙盒页面）
3. **AgentTool插件**：为代理提供新的工具
4. **技能插件**：提供可加载的技能文档 / 工作流
5. **主题插件**：提供覆盖设计令牌的 CSS 文件

### 超出 MVP 范围（已实现）
6. **工作面板视图插件**：在应用的工作面板中停靠隔离的 HTML 视图
7. **MCP 服务器插件**：声明 stdio 或远程 HTTP MCP 服务器，其工具
   加入代理工具集
8. **后台服务插件**：运行由宿主监督的常驻工作进程
9. **插件间消息总线**：对已声明的主题发布消息或订阅消息

### 稍后
- 计费/签名插件
- 企业私有插件源

**当前实现：** 插件页面可以浏览并安装官方市场提供的包。自动更新由用户逐插件选择启用，
且不会静默扩大权限。当前运行时尚未实现能力沙箱：插件入口进程仍可使用原始 Node 内置 API，
因此在计划中的沙箱落地之前，市场插件包仍是以用户权限运行、不受能力限制的代码。

## 4. 插件形状

每个插件都是一个目录：

```text
my-plugin/
├── manifest.json # required
├── package.json # optional (if it carries build artifacts / dependency metadata)
├── main.js # plugin entry; host injects the brokered pi API
├── renderer/ # plugin UI (static assets)
│ ├── index.html
│ └── assets/
├── skills/ # optional
├── themes/ # optional (`.css` files declared in contributes.themes)
├── tools/ # optional (declarative tool schema)
├── icon.png
└── README.md
```

### 安装位置

```text
<dataRoot>/plugins/
 ├── installed/
 │ └── <plugin-id>/
 ├── disabled/
 └── cache/
```

开发者模式可以直接加载本地路径，无需将其复制到 `installed` 中。

## 5. manifest.json（核心合约）

```json
{
 "schemaVersion": 1,
 "id": "demo.hello",
 "name": "Hello Plugin",
 "version": "0.1.0",
 "description": "Example plugin",
 "author": "you",
 "main": "main.js",
 "ui": {
 "panel": "renderer/index.html",
 "width": 480,
 "height": 360
 },
 "contributes": {
 "commands": [
 {
 "id": "hello.say",
 "title": "Hello: Say",
 "keywords": ["hello", "hi"],
 "category": "Demo"
 }
 ],
 "agentTools": [
 {
 "name": "hello_echo",
 "description": "Echo text back",
 "risk": "low",
 "schema": {
 "type": "object",
 "properties": {
 "text": { "type": "string" }
 },
 "required": ["text"]
 }
 }
 ],
 "skills": ["./skills/hello.md"],
 "settings": [
 {
 "key": "greeting",
 "type": "string",
 "default": "Hello",
 "title": "Greeting"
 }
 ]
 },
 "permissions": [
 "ui.panel",
 "agent.prompt.inject",
 "clipboard.read",
 "clipboard.write",
 "notify",
 "fs.read",
 "fs.delete",
 "agent.tool.register"
 ],
 "fs": {
 "read": { "scope": ["**/*"] },
 "delete": { "own": true }
 },
 "engines": {
 "piDesktop": ">=0.1.0"
 }
}
```

### 字段限制
- `schemaVersion` 为必填项，当前格式为 `1`；Rust 宿主（`crates/host-core/src/plugins/manifest.rs`）
  拒绝缺少该字段的 manifest，但目前不校验它是否等于 `1`（见 manifest 规格 §7）
- `id`全球独一无二；建议使用反向域名命名
- `version` 遵循 semver
- `permissions` 必须显式声明
- 未声明的权限默认为无
- 验证失败的清单将被拒绝

## 6. 插件运行时模型

使用**三层隔离**：

```text
Host Main (PI-Desktop)
 ├─ PluginManager
 ├─ PluginPermissionGateway
 ├─ Plugin Sandbox / Worker
 └─ Plugin Panel (Renderer iframe/webview)
```

### 6.1 宿主主进程 {#_6-1-主机主}
- 安装/卸载/启用/禁用
- 验证清单
- 权限管理
- 路由命令和工具调用

### 6.2 插件运行时（独立进程） {#_6-2-插件运行时-受限}
插件无法获得活的 Electron Main 对象。`pi.*` 调用经过宿主代理，但原始 Node 内置 API
仍以当前用户权限运行；进程隔离不等于操作系统能力沙箱。

**当前实现（ADR 0008）：** 每个插件主模块运行在独立的 `utilityProcess`
（`electron/main/plugin-host-process.mjs`）中，通过 JSON RPC 调用
`electron/main/plugin-runtime.ts` 内的代理。代理执行 API 白名单与权限网关检查，插件代码
不会拿到宿主对象。导入宿主私有模块不属于受支持的插件契约。

尚未实现：插件进程内的能力沙箱（当前仍可访问原始 Node 内置 API），以及 CPU / 内存限制。

### 6.3 插件面板用户界面
- 在专用的沙盒 `BrowserWindow` 中加载插件页面，并为每个插件使用隔离的会话分区
- 新建面板的初始页面加载完成前保持窗口隐藏，等待上限为 15 秒；若仍未完成，
  宿主销毁隐藏窗口，并以 `PANEL_LOAD_TIMEOUT` 拒绝打开请求。若页面加载自行失败，
  则保留原始错误。
- 关闭面板（胶囊关闭、禁用、卸载或崩溃拆除）不得读取已销毁的 `BrowserWindow` 或其 `webContents`。宿主必须在窗口仍存活时复制清理拖拽记录所需的 contents id，避免 `closed` 处理程序抛出 `Object has been destroyed`。
- 在 macOS、Windows 和 Linux 上都使用无边框窗口。preload 精确保留透明的
  46px 拖拽带，并只在右上角渲染最简胶囊：最小化、最大化/还原和关闭。
  不显示原生交通灯或主机渲染的面板标题；胶囊之外的拖拽带不可点击，
  开发面板会显示本地化提醒。
- 面板标题可以继续作为旧字符串或本地化的 `{ "en": string,
  "zh-CN": string }` 对象，用于原生窗口身份和启动器元数据，但主机不会
  在面板内部渲染该标题。
- 胶囊跟随插件页面计算得到的背景色和文字色。页面透明时，以当前
  PI-Desktop 主题（`light` / `dark`，包括插件主题的基础色板）作为回退。
- 通过 `--pi-plugin-titlebar-height: 46px` 暴露拖拽带高度；普通流内容会
  自动偏移，固定或粘性插件界面必须使用
  `top: var(--pi-plugin-titlebar-height, 46px)`，而不是 `top: 0`。
  插件自己的工具栏可以使用 `-webkit-app-region: drag`，其中的交互控件
  使用 `-webkit-app-region: no-drag`。
- 当前面板页面声明 `<meta name="pi-plugin-chrome" content="v2">`，并使用公开变量自行设置
  顶部间距。宿主不会再给这些页面加内边距，避免重复安全区域；未声明标记的页面保留历史
  附加偏移，以兼容旧页面。
- 需要铺满宿主拖拽带下方区域的面板，可以声明
  `<meta name="pi-plugin-chrome" content="v3">`。主机保留相同的 46px
  胶囊几何尺寸，但只把页面空白区域切成原生拖拽片段；标准控件以及标记
  `data-pi-plugin-no-drag` 的元素会在拖拽图中形成点击空洞，因此元素存在的
  位置可正常接收指针，空白处仍可拖动窗口；既有面板继续使用严格的 `v2`
  契约。
- 稳定滚动条槽位应只放在面板实际的内容滚动容器上，不应同时放在根级
  `html`/`body` 视口上。Windows 的经典滚动条会把重复的根级预留显示成插件
  表面右侧额外的空白侧栏。
- 插件负责自己的标题、工具栏以及所有其他可见面板界面
- 宿主 preload 为停靠和独立插件面板文档应用全局滚动条契约：宽 6px、无轨道，仅在交互时
  显示。Browser 访客页中加载的外部页面由页面自行控制样式，宿主不改写其样式。
- 在 preload 自己拥有的闭合 Shadow DOM 中渲染主机胶囊，防止插件 CSS 重写控件
- 只能调用插件preload公开的安全API
- 默认情况下无法访问宿主 DOM 或宿主状态存储（store）

## 7. 托管 API（可通过插件调用）

注入的全局对象为 `pi`，`plugin` 只是其中一个命名空间。完整方法索引见
[开发指南](/zh-CN/plugin-development#_13-完整-sdk-接口与源码索引)。

### 基础知识
- `pi.app.getVersion()`
- `pi.plugin.getManifest()`
- `pi.plugin.getSettings()`
- `pi.plugin.setSettings(partial)`
- `pi.commands.register(command)`
- `pi.ui.openPanel(options?)`
- `pi.ui.showToast(message)`
- `pi.ui.notify({ title, body })`
- `pi.ui.getNotificationPermission()`
- `pi.ui.requestNotificationPermission()`
- `pi.ui.showNativeNotification({ title, body? })`

### 工作区元数据与文件范围 {#工作区-需要许可}

元数据读取无需权限；文件操作需要其声明的相应授权。

- `pi.workspace.get()`
- `pi.projects.list()` —— 只读持久化项目元数据，包含未分组记录
- `pi.fs.readText(path)`
- `pi.fs.openDefault(path)` // 使用系统关联应用打开选中的文件
- `pi.fs.openInBrowser(path)` // 在工作面板 Browser 中打开 HTML 文件
- `pi.fs.reveal(path)` // 在系统文件管理器中显示选中的文件
- `pi.fs.writeText(path, content)` // 高风险
- `pi.fs.glob(pattern)`

### Agent（需要许可）
- `pi.project.create({ path })` // `project.create`；返回持久项目 id，但不激活它
- `pi.agent.registerTool(tool)`
- `pi.agent.unregisterTool(name)`
- `pi.models.list()` // `models.list`
- `pi.session.getLlmContext()` // `session.read`；仅限进行中的工具会话
- `pi.session.import()` / `importBatch()` // `session.import`；仅限已声明来源
- `pi.session.list()` / `get()` / `listMessages()` // `session.read.own`
- `pi.session.rename()` // `session.update.own`
- `pi.session.delete()` // `session.delete.own`
- `pi.usage.listTurns()` // `usage.read`；只读已完成回合事实，不含消息正文
- `pi.agent.complete(input)` // `agent.complete`；宿主代发一次性补全

技能以声明方式贡献（`contributes.skills` + `agent.prompt.inject`），
不由插件调用：主机将目录放在系统提示符中，并且
模型通过内置 `Skill` 工具 (D174) 按需加载正文；没有命令式 `appendSystemHint` 宿主 API。
正文加载时，工具结果还标明 `SKILL.md` 所在位置和解析相对引用时应使用的目录；
技能目录仍只包含元数据。

### 后台服务（需要 `background.service`）
- `pi.services.register({ id, start, stop? })`
- `pi.services.unregister(id)`

注册只在本地记录处理器；仅当 manifest 声明该服务且权限已授予时，代理才启动服务，
并监督崩溃后的重启。

### 消息总线（需要许可）
- `pi.bus.publish(topic, payload)` // `bus.publish`
- `pi.bus.subscribe(pattern, handler)` → `unsubscribe()` // `bus.subscribe`
- `pi.events.on(event, handler)` / `pi.events.off(event, handler)` // 主机推送，
  包括原始 `bus.message` 流

### 剪贴板/系统（需要许可）
- `pi.clipboard.readText()`
- `pi.clipboard.getHistory()` // 文本和图片，最新优先
- `pi.clipboard.writeText(text)`
- `pi.shell.openExternal(url)` // 默认确认
- `pi.net.fetch(input)`

`pi.ui.notify` 显示应用内 Toast。插件的原生通知使用 Electron 主进程的通知 API，
并共用清单中的 `notify` 权限。`requestNotificationPermission()` 执行一次简短的原生探测后，
尽力返回原生权限状态（`granted`、`denied`、`unknown` 或 `unsupported`）。
这些通知不是持久化的任务收件箱记录，点击通知也不会激活会话。

### 明确不直接提供
- 任意主机内部 Electron 对象
- 通过代理的 `pi.fs` API 进行任意绝对路径访问

该代理不直接提供 Node 功能。然而，当前
实用程序进程插件运行时不是 Node 功能沙箱：插件代码可以
独立于 `pi.*` 到达原始 Node 内置函数。下面的权限模型
因此，在提供运行时沙箱之前，仅适用于代理 API。

## 8. 权限模型

### 权限列表

| 许可 | 风险 | 描述 |
|---|---|---|
| `ui.panel` | 低 | 显示面板 |
| `ui.view` | 低 | 贡献工作面板视图 |
| `ui.theme` | 低 | 贡献主题 CSS 文件 |
| `clipboard.read` | 中等 | 读取当前剪贴板和主机保留的剪贴板历史 |
| `clipboard.write` | 中等 | 写入剪贴板 |
| `notify` | 低 | 系统通知 |
| `fs.read` | 中等 | 读取 `manifest.fs.read` 列出的路径 |
| `fs.write` | 高 | 写入 `manifest.fs.write` 列出的路径 |
| `fs.delete` | 高 | 删除 `manifest.fs.delete` 列出的路径，进系统回收站 |
| `agent.tool.register` | 高 | 注册代理工具 |
| `agent.prompt.inject` | 高 | 注入提示；激活 `contributes.skills` |
| `net.fetch` | 高 | 网络请求 |
| `shell.openExternal` | 中等 | 打开外部链接 |
| `mcp.server.local` | 高 | 生成 stdio MCP 服务器 |
| `mcp.server.remote` | 高 | 连接远程 HTTP MCP 服务器 |
| `background.service` | 中等 | 保持常驻服务运行 |
| `bus.publish` | 中等 | 发布到已声明的总线主题 |
| `bus.subscribe` | 中等 | 订阅已声明的总线模式 |

主题、MCP 服务器、服务和总线主题均在清单中声明，因此
他们的权限在验证时和运行时都会受到检查 - 请参阅
[13-插件权限-matrix.md](/zh-CN/spec/07-plugins/13-plugin-permissions-matrix)。

三个文件权限除了开关还带一个范围：`manifest.fs` 说明每种模式可以触碰哪些
路径，`manifest.net.domains` 对出网做同一件事。没有声明范围的文件权限就没有
常驻可达范围 —— 每次访问都要问用户。文件范围之前的旧权限名
（`fs.read.workspace` 等）仍然可以加载，并会被降级为最小安全等价物（ADR 0088）。

### 授权时机
1. 安装或升级审核时展示声明的权限列表
2. 仅将已授予权限传给代理运行时；缺少授权会使对应的 `pi.*` 调用失败
3. 用户可在插件管理页撤销权限；正在运行的插件需重新加载，才能使用变更后的授权集

越界文件访问和危险桌面操作使用宿主原生确认，原始 Node API 仍没有操作系统能力沙盒。

## 9. 命令面板

全局命令面板支持：

- 搜索插件命令
- 关键词触发
- 按标题、分类和关键词进行不区分大小写的子串匹配

命令已合并到全局搜索的“命令”区域；当前不提供命令专属的最近使用排序。
分类参与匹配，但不形成分组展示。详见 [09-plugin-command-palette.md](/zh-CN/spec/07-plugins/09-plugin-command-palette)。

交互流程：

```text
User opens the command palette
 → types a keyword
 → matches a plugin command
 → executes the command handler
 → opens a panel or triggers an agent/tool
```

快捷方式（推荐）：
- macOS：`Command+Shift+P` 或自定义
- 支持稍后调用快速启动器

## 10. AgentTool插件机制

插件注册工具后：

1. PluginManager 验证 schema 和权限
2. ToolHost 对工具进行包装
3. 每次调用都先经过权限检查和审计
4. 实际执行落在插件运行时
5. 结果在返回给代理之前进行归一化

包装层必须添加：
- 超时
- 参数验证
- 错误归一化
- 审计日志记录
- 禁用开关

## 11. 插件生命周期

```text
discover → validate → install → enable → load → running
 ↘ disable → unload
 ↘ uninstall → purge
```

挂钩：
- `onInstall`
- `onLoad`
- `onEnable`
- `onDisable`
- `onUnload`
- `onUninstall`

**当前实现：** 运行时（`apps/desktop/electron/main/plugin-runtime.ts`）在加载 / 启用插件时
调用 `onLoad`，停止插件进程前在其中调用 `onUnload`，预算为 5 秒。卸载运行时会移除插件注册的
命令和工具。其他 Hook 属于历史规划，目前既不在公开 `PluginModule` 类型中，也不会触发。

**计划：** 完整生命周期落地后，钩子将按以下顺序触发：安装 → 启用 → 加载 →（运行）→ 卸载运行时（unload）→ 禁用 → 卸载插件（uninstall）。详细顺序见 [05-plugin-lifecycle.md](/zh-CN/spec/07-plugins/05-plugin-lifecycle)。

失败政策：
- 加载失败：标记错误，不影响主机启动
- 工具执行失败：返回工具错误，不要使主进程崩溃

## 12. 扩展 UI

应用程序外壳的专用**扩展**目标拥有用户添加的所有内容
到应用程序。不要在“设置”中重复任何内容。

扩展目标只保留两个选项卡，因为它是插件页面：

| 选项卡 | 内容 |
|---|---|
| 已安装 | 插件，分组：需要注意、更新、活动、禁用 |
| 市场 | 浏览并安装 |

MCP、技能和子代理由设置 > 智能体下的三个独立页面管理，不再在扩展页重复。
插件功能仍包括：
- 本地安装（选择目录/zip）
- 开发人员加载（路径）
- 激活范围（关闭/本项目/各处）
- 卸载
- 查看权限
- 查看日志
- 打开插件目录

状态指示灯：
- 启用
- 禁用
- 错误
- 开发加载

### 12.1 激活范围控制

同一控件适用于三类扩展（D192）。三个分段按生效范围递增排列：
**关闭 → 指定项目 → 所有项目**。扩大和缩小范围使用方向相反的相同手势；
中间分段生效时，可点击摘要标签打开项目选择器。

控件遵循以下规则：
- 选择“指定项目”且尚未选择任何项目时，默认加入当前打开的项目，因此常见情况只需一次点击。
- 切换到“所有项目”或“关闭”会保留项目列表，切回“指定项目”时可恢复原有选择。
- 已在生效范围内、但不再出现在最近项目列表中的项目仍会显示在选择器中，确保用户能取消选择。
- 选择项目范围却未包含任何项目时，显示明确警告，避免扩展悄无声息地不生效。

### 12.2 设置 > 智能体中的 MCP 管理

- MCP 页面使用全局和选中项目的独立栏，根目录为 `~/.agents/servers` 和
  `<project>/.agents/servers`。
- 新增和编辑复用 `McpEditorSheet`，包含 stdio/HTTP 卡片、环境变量/请求头行、
  校验、重名拦截和测试连接。
- 启用状态存于应用本地；运行时过滤关闭项前，项目记录先遮蔽全局记录。
- 此前已向模型公开的用户 MCP 工具，在传输断开或保存的连接被编辑后仍可路由。下一次调用会
  对当前保存的服务器重新握手，并在派发前用新列表校验该工具；不必再做
  一次 `ToolSearch`。未知名称不会触发发现。
- 恢复前、后都会检查启用状态和项目作用域。删除服务器或销毁运行时会丢掉
  记住的名称；过期的进行中握手不能把它们恢复回来。并发调用共享一次握手。
- 恢复失败报告 `UNAVAILABLE`，并沿用现有失败策略（编辑或测试连接后再试），
  而不是每次调用都反复连接。已移除的工具返回 `TOOL_NOT_FOUND`。恢复从不
  重放失败的 `tools/call`，因为那次调用可能已经产生过副作用。

- Streamable HTTP 对通知和客户端响应返回的 `202 Accepted` 确认不是 JSON-RPC 回复。
  所有确认正文（包括纯文本 `Accepted`）都会丢弃；普通请求的回复仍遵循 JSON/SSE 解析
  和响应大小限制。
- Streamable HTTP 服务器可以先返回 JSON-RPC 回复，再继续保持 SSE 流开启，用于保活或
  由服务器自行安排结束的会话。每个 `text/event-stream` 事件到达即分发，因此握手或
  `tools/list` 分页在收到对应回复时就完成，无需等待流结束。交互仍受请求预算约束：
  从不回复的服务器会超时，超过请求存活期仍未关闭的流会被中止。
- MCP 条目仅在运行时明确报告 `authRequired` 时显示“需要授权”。缺少凭据、连接尚未测试
  或非认证失败都不代表必须 OAuth。已保存 OAuth 凭据也不能掩盖后续认证失败。
  HTTP 服务器菜单仍提供手动 OAuth 授权。

### 12.3 设置 > 智能体中的技能管理

- 技能页面使用 `~/.agents/skills` 和 `<project>/.agents/skills` 下的全局/项目栏。
- 页面在用户自有的全局和项目分组上方，单列**内置技能**分组。每项都有默认开启的全局启用
  开关，用户无需编辑或删除打包文档就能停用它。
- 停用内置技能后，它不再出现在有效会话目录或输入框的 `/skill:<id>` 条目中。过时的直接
  `Skill` 加载会报告技能已停用。激活状态保存在独立的
  `<data>/agent-capabilities/skill-builtins.json` 中，不会被用户文档扫描时的清理过程移除。
- 内置技能激活只控制技能目录及按需加载文档，不禁用或注销与技能关联的 Agent 工具；
  工具的启用状态独立管理。
- 每栏有原生单文件导入和文件夹导入操作，后者可一次选择多个 `<name>/SKILL.md` 文件夹。
  宿主逐个独立导入所选文件夹，保留同级资源；部分失败会报告，但不回滚已成功导入项。
  若上次成功导入源目录的父目录仍存在，下次文件夹选择器从该父目录打开；取消或全部失败
  不改变这个本机偏好值。
- 导入或扫描 `SKILL.md` 时，若 frontmatter 名称不是 ASCII slug，则用父目录名作为
  id；折叠 YAML 描述仍进入目录。可读文档不会因为标题是非 ASCII 而被丢掉。
- 描述作为目录摘要，模型调用 `Skill` 时才读取正文 (D174、D194)。

## 13. 开发者经验

提供：

1. 插件模板：`npm create pi-desktop-plugin`
2. 清单 schema 验证器
3. 开发者热重载（监听目录变化）
4. 插件示例：
 - 你好面板
 - 工作区欢迎工具
 - 剪贴板笔记

本地开发流程：

```bash
# develop the plugin
cd plugins/hello
pnpm dev

# in PI-Desktop
Plugins → Load Development Plugin → choose directory
```

## 14. 与 pi 生态系统的关系

| 生态系统对象 | 关系 |
|---|---|
| pi 技能 | 可以通过技能插件分发/管理 |
| pi 扩展 | 由插件以 `contributes.agentExtensions` 加 `agent.extension` 授权贡献；pi CLI 扩展可导入为开发插件（D387 / D388、ADR 0214 / 0215、[16-trusted-extensions.md](/zh-CN/spec/07-plugins/16-trusted-extensions)） |
| MCP | 插件在 `contributes.mcpServers` 中声明 MCP 服务器；他们的工具加入代理的工具集中 |
| Agent 工具 | 最重要的插件扩展界面之一 |

原则：
- 不排除 pi 原生功能
- 但在用户方面，将一切称为“插件”

## 15. 安全基线（不可协商）

1. 插件默认没有权限
2. 插件无法直接访问宿主渲染器状态
3. 插件默认无法读写工作区之外的文件
4. 插件网络功能默认关闭
5. 插件更新 / 安装需要完整性验证（签名支持后续提供）
6. 宿主核心进程不执行插件注入的任意 Electron 主进程代码

## 16. 分阶段推出

### P0（先设计，可与M2/M3并行准备）
- 清单规格
- PluginManager 骨架
- 本地加载/启用-禁用
- 命令注册
- 1 个示例插件

### P1
- 插件面板用户界面
- 权限授予UX
- AgentTool注册和调用
- 插件设置存储

### P2
- ZIP 包安装
- 插件日志中心
- 开发人员热重载
- 更多官方示例

### P3
- 插件市场
- 签名和自动更新
- MCP 插件类型
- 后台服务插件

## 17. MVP产品策略调整

最初的 MVP 可以推迟开放“完整插件市场”，但应保留：

- 插件目录
- 清单
- PluginManager 接口
- 至少一个内置/示例插件路径

即：

> **首先有插件架构，然后是插件生态系统。**

## 18. 验收（最小可用插件系统）

1. 用户可以从本地目录加载插件
2. 插件命令出现在命令面板中
3. 插件可以打开自己的面板页面
4. 插件可以注册低风险 Agent 工具并成功调用
5. 禁用插件会立即停用其命令和工具
6. 插件崩溃不会导致宿主退出

## 19. 示例

存储库中的示例插件：

- `examples/plugins/hello`
