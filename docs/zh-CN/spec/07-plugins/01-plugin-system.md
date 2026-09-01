# 01. 插件系统

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/01-plugin-system) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 0. 冻结实现默认值

- 插件工具公开名称使用强制前缀 `plugin_<pluginIdSafe>_<toolName>` (D015)
- 启用→加载失败自动禁用插件（D017）
- 卸载默认删除插件数据（D016）
- MVP (D018) 中不允许使用插件设置机密
- 运行时目标仍然是单独的进程； M4 可以使用主机管理的沙盒运行时 (D009)
- 每个扩展都带有 `enabled` 以及激活范围；两个插件和
  用户自己的 MCP 服务器和技能是全局的或仅限于指定项目 (D192)
- 用户 MCP 工具使用前缀 `mcp_<serverId>_<toolName>`，与 D015 不相交
  插件命名空间 (D193)

Plan 策略：插件代理工具、注册工具的插件技能以及任何
未知的插件贡献在 Plan 中不可见或可执行。这否认
在通用插件权限评估之前由 host-core 强制执行，并且不能
可以被低风险清单、会话授权或 `auto` 绕过。插件工具
在批准的 Plan → Agent 转换后，对同一 Agent 仍然可用。

## 1. 目标

为 PI-Desktop 提供类似于已建立的桌面插件生态系统的可扩展性（例如 VS Code 扩展）：

- 用户可以安装/启用/禁用/卸载插件
- 开发人员可以构建自定义插件
- 插件可以扩展命令、面板、工具和 Agent 功能
- 平台保持安全边界，不会将完整的系统权限直接交给任意第三方代码

用一句话来说：

> **PI-Desktop 是主持人；插件是功能包。**

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
- 插件默认无法直接获取任意Node/Electron权限

## 3. 插件可以做什么

### MVP-Plugin 范围（插件系统的第一次迭代）
1. **命令插件**：注册命令面板操作
2. **面板插件**：打开插件UI面板（iframe / webview沙盒页面）
3. **AgentTool插件**：为代理提供新的工具
4. **技能插件**：提供可加载的技能documents/flows
5. **主题插件**：提供覆盖设计令牌的 CSS 文件

### 超出 MVP 范围（已实现）
6. **MCP 服务器插件**：声明 stdio 或远程 HTTP MCP 服务器，其工具
   加入代理工具集
7. **后台服务插件**：让受监督的驻地工人保持活力
8. **插件间消息总线**：声明主题上的 publish/subscribe

### 稍后
- 计费/签名插件
- 企业私有插件源

**当前实现：** Plugins页面可以浏览和安装包
来自官方市场提供商。每个插件自动更新是可选的并且
拒绝静默权限扩展。这不是功能沙盒运行时：
插件主进程保留原始 Node 内置程序，因此市场包是
在实施计划的沙箱之前，不受限制的用户特权代码。

## 4. 插件形状

每个插件都是一个目录：

```text
my-plugin/
├── manifest.json # required
├── package.json # optional (if it carries build artifacts / dependency metadata)
├── main.js # plugin runtime extension entry (restricted API)
├── preload.js # optional, plugin panel bridge
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
~/.pi-desktop/plugins/
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
 },
 "entrypoints": {
 "onLoad": "main.js#onLoad",
 "onUnload": "main.js#onUnload"
 }
}
```

### 字段限制
- `schemaVersion` 为必填项，且必须为 `1`； Rust 主机 (`crates/host-core/src/plugins.rs`) 会拒绝没有它的清单
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

### 6. 1 主机主
- 安装/卸载/启用/禁用
- 验证清单
- 权限管理
- 路由命令和工具调用

### 6. 2 插件运行时（受限）
插件逻辑在受限环境中运行；它不等同于完整的 Electron 主要权限。

**今天实施（ADR 0008）：**每个插件的主模块都在自己的中运行
`utilityProcess` (`electron/main/plugin-host-process.mjs`) 并到达主机
仅通过 JSON RPC 到 `electron/main/plugin-runtime.ts` 中的经纪商，其中
强制执行 API 白名单和权限网关。插件代码永远不会得到
主机对象并且不能 `require` 主机模块。

仍然开放：插件进程内的功能沙箱（原始 Node 内置
可以到达）和 CPU/memory 限制。

### 6. 3 插件面板用户界面
- 在专用的沙盒 `BrowserWindow` 中加载插件页面，并为每个插件使用隔离的会话分区
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
- 需要全出血绘制到主机拖拽带下方的面板，可以声明
  `<meta name="pi-plugin-chrome" content="v3">`。主机保留相同的 46px
  胶囊几何尺寸，但只把页面空白区域切成原生拖拽片段；标准控件以及标记
  `data-pi-plugin-no-drag` 的元素会在拖拽图中形成点击空洞，因此元素存在的
  位置可正常接收指针，空白处仍可拖动窗口；既有面板继续使用严格的 `v2`
  契约。
- 稳定滚动条槽位应只放在面板实际的内容滚动容器上，不应同时放在根级
  `html`/`body` 视口上。Windows 的经典滚动条会把重复的根级预留显示成插件
  表面右侧额外的空白侧栏。
- 插件负责自己的标题、工具栏以及所有其他可见面板界面
- 在 preload 自己拥有的闭合 Shadow DOM 中渲染主机胶囊，防止插件 CSS 重写控件
- 只能调用插件preload公开的安全API
- 默认情况下无法访问主机 DOM/主机存储

## 7. 托管 API（可通过插件调用）

命名空间：`pi.plugin.*`

### 基础知识
- `pi.app.getVersion()`
- `pi.plugin.getManifest()`
- `pi.plugin.getSettings()`
- `pi.plugin.setSettings(partial)`
- `pi.commands.register(command)`
- `pi.ui.openPanel(options?)`
- `pi.ui.showToast(message)`
- `pi.ui.notify(title, body)`
- `pi.ui.getNotificationPermission()`
- `pi.ui.requestNotificationPermission()`
- `pi.ui.showNativeNotification({ title, body? })`

### 工作区（需要许可）
- `pi.workspace.get()`
- `pi.fs.readText(path)`
- `pi.fs.openDefault(path)` // 使用系统关联应用打开选中的文件
- `pi.fs.reveal(path)` // 在系统文件管理器中显示选中的文件
- `pi.fs.writeText(path, content)` // 高风险
- `pi.fs.glob(pattern)`

### Agent（需要许可）
- `pi.agent.registerTool(tool)`
- `pi.agent.unregisterTool(name)`

技能以声明方式贡献（`contributes.skills` + `agent.prompt.inject`），
不由插件调用：主机将目录放在系统提示符中，并且
模型通过内置的 `Skill` 工具 (D174) 加载主体。有计划，没有
目前曝光：`pi.agent.appendSystemHint(text)`。

### 后台服务（需要 `background.service`）
- `pi.services.register({ id, start, stop? })`
- `pi.services.unregister(id)`

登记为本地记账；代理仅在以下情况下启动服务
清单声明了它并授予了权限，并监督重新启动。

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

`pi.ui.notify` 是一个应用内 Toast。本机插件通知使用
Electron 主进程通知 API 并共享清单 `notify`
许可。 `requestNotificationPermission()` 返回尽力而为的原生
权限状态（`granted`、`denied`、`unknown` 或 `unsupported`）之后
执行简短的本机探测。这些通知不是持久任务
收件箱记录，单击时不会激活会话。

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
1.安装或升级审核时显示声明的权限列表
2. 只有授予的权限才会传递给代理运行时；缺少补助金
   相应的 `pi.*` 调用失败
3、用户可以在插件管理页面撤销权限；重新加载是
   正在运行的插件需要观察更改的授权集

未实施每次调用确认和直接 Node 访问的任何策略。

## 9. 命令面板

全局命令面板支持：

- 搜索插件命令
- 关键词触发
- 最近使用过
- 按类别分组

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

1.PluginManager验证schema和权限
2. ToolHost对工具进行包装
3、每次调用都先经过权限和审核
4. 实际执行落在插件运行时
5. 结果在返回给代理之前进行归一化

包裹层必须添加：
- 超时
- 参数验证
- 误差标准化
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

**今天实现：**运行时（`apps/desktop/electron/main/plugin-runtime.ts`）调用`onLoad`（当load/enable上加载插件时）和`onUnload`（在插件进程中，停止之前，5s预算）；卸载会删除插件注册的命令和工具。其他钩子在 API 中声明，但尚未触发。

**计划：**一旦完整生命周期落地，钩子将按以下顺序触发：安装→启用→加载→（运行）→卸载→禁用→卸载。有关详细序列，请参阅 [05-plugin-lifecycle.md](/zh-CN/spec/07-plugins/05-plugin-lifecycle)。

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

### 12. 1 激活范围控制
### 12. 1 激活范围控制

一个控制器可用于所有三种类型 (D192)。这是一个三段轨道有序
通过扩大影响范围 - **关闭 → 这些项目 → 无处不在** - 如此扩大和
缩小是在相反方向上相同的手势，加上一个摘要芯片
当中间段处于活动状态时打开项目选择器。

控制编码规则：
- 选择“这些项目”，没有任何选择，但种子当前开放
  项目，所以常见情况是一键点击。
- 切换到“无处不在”或“关闭”会保留项目列表，因此可以返回
  恢复它。
- 已确定范围但不再出现在最近列表中的项目仍会出现在
  选择器，否则范围将永远无法撤消。
- 具有空列表的项目范围扩展会发出警告，而不是默默执行
  什么也没有。

### 12. 2 设置 > 智能体中的 MCP 管理

- MCP 页面使用全局和选中项目的独立栏，根目录为 `~/.agents/servers` 和
  `<project>/.agents/servers`。
- 新增和编辑复用 `McpEditorSheet`，包含 stdio/HTTP 卡片、环境变量/请求头行、
  校验、重名拦截和测试连接。
- 启用状态存于应用本地；运行时过滤关闭项前，项目记录先遮蔽全局记录。

### 12. 3 设置 > 智能体中的技能管理

- 技能页面使用 `~/.agents/skills` 和 `<project>/.agents/skills` 下的全局/项目栏。
- 每栏只有一个原生单文件“导入”操作；主机会物理复制文件并扫描 frontmatter。
- 描述作为目录摘要，模型调用 `Skill` 时才读取正文 (D174、D194)。

## 13. 开发者经验

提供：

1.插件模板：`npm create pi-desktop-plugin`
2.清单模式验证器
3.开发者热重载（watch目录）
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
| 圆周率技能 | 可以通过技能插件分发/管理 |
| 圆周率扩展 | 不直接等同；需要一个适配器层 |
| MCP | 插件在 `contributes.mcpServers` 中声明 MCP 服务器；他们的工具加入代理的工具集中 |
| Agent 工具 | 最重要的插件扩展界面之一 |

原则：
- 不排除 pi 原生功能
- 但在用户方面，将一切称为“插件”

## 15. 安全基线（不可协商）

1.插件默认没有权限
2.插件无法直接访问主机渲染器状态
3.插件默认无法读写工作区之外的文件
4.插件网络功能默认关闭
5.插件更新/安装需要完整性验证（稍后签名）
6.主机核心进程不执行插件注入的任意Electron主代码

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
- 压缩安装
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
- 插件管理器界面
- 至少一个内置/示例插件路径

即：

> **首先有插件架构，然后是插件生态系统。**

## 18. 验收（最小可用插件系统）

1. 用户可以从本地目录加载插件
2. 插件命令出现在命令面板中
3.插件可以打开自己的面板页面
4.插件可以注册低风险代理工具并成功调用
5. 禁用插件会立即停用其命令和工具
6.插件崩溃不会导致主机退出

## 19. 示例

存储库中的示例插件：

- `examples/plugins/hello`
