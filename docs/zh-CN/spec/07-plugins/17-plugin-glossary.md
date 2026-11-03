# 17. 插件中英术语对照表

> **翻译说明：** 本页与[英文源规格](/spec/07-plugins/17-plugin-glossary)逐项对应。英文术语作为检索键，代码、协议字段和标识符保持原文。

本表统一插件开发和文档审校中的中文用语，并说明容易混淆的技术边界。每项均链接到相应契约，具体行为以该契约及当前实现为准。

## 1. 使用约定

- 首次引入概念时，可写“中文术语（English term）”，后续沿用表中的推荐中文。Agent 在插件正文中沿用英文，首次出现可注明“智能体”；“代理”用于网络代理语境。
- 保留标识符的大小写及拼写，例如 `agent.extension`、`manifest.renderer`、`sessionId`、`turnId`；不把翻译后的名称当成 API。
- 区分“宿主”与网络“主机”、“运行时”与“运行时长”。涉及进程、授权或 ID 时，明确它们所属的组件和接口。
- 表中的中文是技术说明的推荐用语；引用界面标签、日志、协议字面量时保留其原始名称。

## 2. 执行与信任

| English term | 推荐中文 | 含义与使用边界 | 契约依据 |
|---|---|---|---|
| Agent | Agent（智能体） | 由模型驱动、进行推理并调用工具的执行循环。插件文档正文沿用 Agent；网络中介使用“网络代理”。 | [Agent 运行时](../03-runtime/02-agent-runtime.md) |
| Host | 宿主 | 加载插件并提供 API 的 PI-Desktop 应用。涉及具体职责时，应明确写出 Electron 主进程或 Rust host-core。 | [进程模型](../03-runtime/07-process-model.md) |
| Rust host-core | Rust 宿主核心 | 负责 SQLite、宿主持久化状态和原生宿主操作的 Rust 组件，与 Electron 主进程职责不同。 | [进程模型](../03-runtime/07-process-model.md) |
| Agent Runtime | Agent 运行时 | 集成 Agent 循环、模型调用、工具和 Agent 扩展的 Node 运行时。此处 runtime 指执行环境，不是运行时长。 | [Agent 运行时](../03-runtime/02-agent-runtime.md) |
| Sidecar | 伴随进程（sidecar） | 由宿主管理的子进程，例如 Rust host-core 或 Node Agent 运行时。应注明具体进程；sidecar 一词本身不说明信任边界。 | [进程模型](../03-runtime/07-process-model.md) |
| Plugin process | 插件进程 | 执行插件主入口的独立 Electron `utilityProcess`。其原生 Node API 仍具有当前操作系统用户的权限。 | [规格 01](01-plugin-system.md) |
| Renderer | 渲染器 | 负责呈现界面的 Electron 进程。应区分承载受信任渲染器扩展的应用渲染器，与隔离的插件面板／视图页面。 | [进程模型](../03-runtime/07-process-model.md) |
| Process isolation | 进程隔离 | 在独立进程中运行插件主入口，使其无法持有 Electron 主进程的实时对象。它不会约束原生 Node 文件或网络访问。 | [规格 04](04-plugin-security.md) |

## 3. 插件贡献项

| English term | 推荐中文 | 含义与使用边界 | 契约依据 |
|---|---|---|---|
| Plugin | 插件 | PI-Desktop 中以清单为基础的安装、启用、授权和功能贡献单元。Agent 扩展是由插件持有的贡献项。 | [规格 01](01-plugin-system.md) |
| Manifest | 插件清单（manifest） | `manifest.json` 中对插件标识、入口、权限和所提供功能的声明。声明表达能力需求，本身不等于用户授权。 | [规格 02](02-plugin-manifest-schema.md) |
| Contribution / contribution point | 贡献项／贡献点 | 贡献项是声明提供的功能，如命令或主题；贡献点是宿主接收该功能的位置或字段，如 `contributes.commands`。 | [规格 02](02-plugin-manifest-schema.md) |
| Command | 命令 | 可从命令面板或经授权的快捷键调用的已注册动作。注册命令本身不会同时注册 Agent 工具。 | [规格 09](09-plugin-command-palette.md) |
| Agent tool | Agent 工具 | 向 Agent 暴露的操作，包含名称、描述、参数 schema 和执行处理器。宿主为插件工具名添加命名空间前缀。 | [规格 03](03-plugin-api.md) |
| Skill | 技能 | 可被发现、并按需将正文载入模型上下文的指令文档。技能不是可执行的 `ExtensionAPI` 模块，也不是 MCP 服务器。 | [规格 01](01-plugin-system.md) |
| MCP server | MCP 服务器 | 可向 Agent 提供工具的模型上下文协议服务器。插件贡献项声明 stdio 或 HTTP 传输，并受对应权限约束。 | [规格 02](02-plugin-manifest-schema.md) |
| Background service | 后台服务 | 由插件声明并注册、在插件进程中受宿主监督启动和停止的常驻服务。它不是独立的操作系统服务。 | [规格 05](05-plugin-lifecycle.md) |
| Provider | 服务提供方（Provider） | 表示模型服务集成的宿主记录，包含协议和认证配置。插件提供方贡献项生成由宿主持有的记录。 | [规格 02](02-plugin-manifest-schema.md) |
| Adapter | 适配器 | 将某种协议或 API 映射到运行时的实现层，例如语音适配器或 Desktop `ExtensionAPI` 适配器。应注明所适配的接口。 | [规格 16](16-trusted-extensions.md) |
| Agent extension / trusted extension | Agent 扩展／受信任扩展 | 通过所支持的 `ExtensionAPI` 子集在 Agent 伴随进程内执行的 `contributes.agentExtensions` 模块，需要 `agent.extension` 权限。它不在插件主入口进程中执行。 | [规格 16](16-trusted-extensions.md) |
| Renderer extension | 渲染器扩展 | 由 `manifest.renderer` 指定、经 `renderer.extension` 授权载入应用渲染器的 ES 模块。它与宿主共享文档，UI 插槽不是沙箱。 | [规格 13](13-plugin-permissions-matrix.md) |

## 4. 界面承载形式

| English term | 推荐中文 | 含义与使用边界 | 契约依据 |
|---|---|---|---|
| Plugin panel | 插件面板 | 由 `manifest.ui.panel` 指定、经 `ui.panel` 授权在独立 `BrowserWindow` 中打开的隔离 HTML 入口。悬浮小组件是面板的一种呈现形式，不是渲染器扩展。 | [规格 03](03-plugin-api.md) |
| Work panel view | 工作面板视图 | 通过 `contributes.views` 声明、停靠在应用工作面板中的 HTML 界面。它与独立插件面板使用相同的面板桥接接口和隔离策略。 | [规格 03](03-plugin-api.md) |
| UI slot | UI 插槽 | 由宿主定义、供渲染器扩展通过 `pi.slots.register` 注册组件的挂载点。它位于宿主文档中，与隔离 HTML 视图不同。 | [规格 13](13-plugin-permissions-matrix.md) |
| Composer | 消息输入框（Composer） | 承载消息草稿和附件的聊天输入界面。应区分由用户触发的输入框转换、Agent 工具和自动发送消息。 | [规格 03](03-plugin-api.md) |

## 5. 授权与执行上下文

| English term | 推荐中文 | 含义与使用边界 | 契约依据 |
|---|---|---|---|
| Permission | 权限 | 在 `manifest.permissions` 中声明的宿主 API 能力标识，例如 `fs.read` 或 `agent.extension`。风险等级不等于已获授权。 | [规格 13](13-plugin-permissions-matrix.md) |
| Grant | 授权 | 宿主记录的、对所申请权限的批准。经 broker 调用 API 时，同时检查权限声明与授权，以及适用的资源约束。 | [规格 04](04-plugin-security.md) |
| Consent / confirmation | 用户同意／用户确认 | 用户对宿主持有的审批提示所作的答复，例如同意一次超出声明范围的文件请求。不能假定每次权限检查都会弹出首次使用提示。 | [规格 04](04-plugin-security.md) |
| Activation scope | 激活范围 | 控制已启用插件在哪些位置适用的全局或指定项目范围。它不授予文件访问权，也不替代权限授权。 | [规格 01](01-plugin-system.md) |
| Filesystem scope | 文件访问范围 | `manifest.fs.read.scope`、`manifest.fs.write.scope` 和 `manifest.fs.delete.scope` 中用于约束 broker 文件操作的根目录相对路径模式。它与插件的激活范围不同。 | [规格 04](04-plugin-security.md) |
| Plugin-private data directory | 插件私有数据目录 | `pi.plugin.getDataPath()` 返回的调用方插件数据目录，与插件代码和宿主数据库分开。“私有”表示命名空间隔离，不代表操作系统沙箱。 | [规格 11](11-plugin-storage-isolation.md) |
| Workspace | 工作区 | `pi.workspace.get()` 返回的当前项目文件夹上下文，包含主根目录及可选的项目组根目录。读取这些元数据不授予文件访问权；`remote-project:` 标识不是本地路径。 | [规格 03](03-plugin-api.md) |
| Project / project group | 项目／项目组 | 项目记录与逻辑文件夹组是不同的宿主实体。`pi.projects.list()` 每条结果中的 `projectId` 标识项目，`pi.workspace.get()` 返回的 `projectId` 标识项目组；两者不能互换。 | [规格 03](03-plugin-api.md) |
| Session | 会话 | 由 `sessionId` 标识、具有自身会话记录和运行时上下文的 Agent 对话。它与 Chromium 会话分区不同。 | [规格 03](03-plugin-api.md) |
| Turn | 回合 | 会话中由宿主跟踪、以 `turnId` 标识的一次执行，可包含多次模型请求和工具调用；到达终止状态不一定表示任务成功。 | [规格 03](03-plugin-api.md) |
| Model context | 模型上下文 | 为模型请求准备的消息与指令。`session.getLlmContext` 返回调用工具所在会话的有界投影，并考虑上下文压缩，不是无限制的会话记录读取。 | [规格 03](03-plugin-api.md) |

## 6. 通信与隔离

| English term | 推荐中文 | 含义与使用边界 | 契约依据 |
|---|---|---|---|
| IPC | 进程间通信（IPC） | 跨进程边界的通信。应用渲染器 IPC、插件进程通道和面板桥接接口各有不同的调用方及可调用方法集合。 | [规格 12](12-plugin-ipc-and-host-services.md) |
| RPC | 远程过程调用（RPC） | 跨边界的请求／响应式过程调用。“远程”不要求跨网络主机；插件 broker 也通过本地进程消息交换调用。 | [规格 12](12-plugin-ipc-and-host-services.md) |
| Broker | 调用中介（broker） | 位于 Electron 主进程的调用分发层，负责路由插件 `pi.*` 请求、检查权限和资源策略并调用宿主服务。它不是网络代理。 | [规格 12](12-plugin-ipc-and-host-services.md) |
| Panel bridge | 面板桥接接口 | 由 preload 暴露、供隔离面板／视图页面使用的 `window.pluginBridge` 接口。它不会暴露插件进程中的完整 pi 对象。 | [规格 03](03-plugin-api.md) |
| Message bus | 消息总线 | 由宿主路由、受声明主题／订阅模式和授权约束的插件间发布／订阅消息通道。收到的载荷传递数据，不附带额外权限。 | [规格 04](04-plugin-security.md) |
| Sandbox | 沙箱 | 由运行环境强制执行的隔离边界。插件面板／视图页面启用 Electron 沙箱且关闭 Node 集成；插件主入口、受信任渲染器扩展和 Agent 扩展采用不同的信任模型。 | [规格 04](04-plugin-security.md) |
| Session partition | Chromium 会话分区 | 面板／视图页面使用的、按插件划分的 Chromium 存储与 Cookie 会话。它不是 Agent 会话，也不是独立的操作系统用户。 | [规格 04](04-plugin-security.md) |
| Egress allowlist | 出站访问白名单 | 在宿主介入的网络路径上检查的 `manifest.net.domains` 规则。`net.anyHost` 另行控制白名单豁免，其他端点限制仍然有效。该策略不会为原生 Node 网络访问提供沙箱。 | [规格 04](04-plugin-security.md) |
| Network proxy | 网络代理 | 用于出站 HTTP／SOCKS 流量的可配置网络中介。应与 Agent 及插件调用中介 broker 区分。 | [ADR 0177](../../../adr/0177-user-configurable-outbound-proxy.md) |

## 7. 生命周期

| English term | 推荐中文 | 含义与使用边界 | 契约依据 |
|---|---|---|---|
| Enabled / loaded | 已启用／已加载 | “已启用”是持久化的用户选择；“已加载”表示当前运行时实例存在。注册表中有记录不代表进程正在运行。 | [规格 05](05-plugin-lifecycle.md) |
| Hot reload | 热重载 | 开发插件源码变化后重新加载插件。宿主会检查已记录的权限／文件范围批准；修改 manifest 不会静默扩大已批准的访问范围。 | [规格 10](10-plugin-devex.md) |
| Unload / uninstall | 卸载运行实例／卸载插件 | 卸载运行实例会撤销其资源并保留私有数据；卸载插件默认删除注册记录、受管理的代码与私有数据，但保留开发源码。 | [规格 11](11-plugin-storage-isolation.md) |
