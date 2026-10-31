# 13. 插件权限矩阵

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/13-plugin-permissions-matrix) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 目标

提供权限-能力-风险-默认策略参考表，供 UI 复制和验证重用。

## 2. 矩阵

| 许可 | 风险 | 允许的 API/功能 | 默认政策 | 注释 |
|---|---|---|---|---|
| `ui.panel` | 低 | 打开插件面板 | 安装时授予 | 几乎所有 UI 插件都需要 |
| `ui.view` | 低 | `contributes.views` 在工作面板中列出并可打开 | 安装时授予 | 与面板窗口同级隔离：沙箱页面、按插件划分的会话分区、`net.domains` 出口限制。按激活范围过滤 |
| `ui.theme` | 低 | `contributes.themes` CSS 已在“设置”中加载并提供 | 安装时授予 | CSS 由主机清理；它无法编写脚本。已声明的 `assets` 通过主机的只读 `plugin-asset:` 协议提供 |
| `ui.settings` | 低 | `contributes.scenicThemes` 在“扩展”中添加沙盒设置项 | 安装时授予 | 仅在宿主“扩展”分组中呈现；使用与面板视图相同沙箱的隔离视图宿主（ADR 0261） |
| `ui.window.appearance` | 低 | 该插件主题被选中时，用 `contributes.windowAppearance` 设置原生窗口背景 | 安装时授予 | 仅接受 `#rrggbb` / `#rrggbbaa`；按解析后的明暗生效，主题消失后回到宿主默认值。macOS 保持 vibrancy |
| `clipboard.read` | 中等 | `clipboard.readText`、`clipboard.getHistory` | 首次使用时确认 | 可能会读取敏感信息和保留的剪贴板历史 |
| `clipboard.write` | 中等 | `clipboard.writeText` | 首次使用时确认 | 防止剪贴板污染 |
| `notify` | 低 | `ui.notify`、`ui.getNotificationPermission`、`ui.requestNotificationPermission`、`ui.showNativeNotification` | 可以默认授予 | 本机交付由操作系统控制；避免通知垃圾邮件滥用 |
| `fs.read` | 中等 | `fs.readText` / `fs.readPreview` / `fs.openDefault` / `fs.reveal` / `fs.glob` / `fs.list` / `fs.requestDirectory` | 安装时授予，范围由 `manifest.fs.read` 限定 | `fs.readPreview`、`fs.openDefault` 和 `fs.reveal` 仅限显式选择的文件和相同的读取范围；所有文件调用仍受根目录与拒绝列表保护 |
| `fs.write` | 高 | `fs.writeText` | 安装时授予，范围由 `manifest.fs.write` 限定 | 必须声明范围；整棵树的模式无法通过校验。范围外要问用户 |
| `fs.delete` | 高 | `fs.remove` | 安装时授予，范围由 `manifest.fs.delete` 限定 | 分两档（`own` / `scope`），一律进系统回收站，不递归，并有速率刹车（§2B） |
| `fs.read.workspace` | 中等 | — | 加载时降级为 `fs.read` + 整棵树范围 | 旧权限名，早于文件范围机制 |
| `fs.write.workspace` | 高 | — | 加载时降级为 `fs.write` 且**没有**范围 | 旧权限名；在 manifest 声明范围之前，每次写入都要问用户 |
| `fs.delete.workspace` | 高 | — | 加载时降级为 `fs.delete` + `own: true` | 旧权限名；只有插件自己写过的文件才不用问 |
| `agent.tool.register` | 高 | 注册代理工具 | 安装时确认 | 工具执行情况单独审核 |
| `agent.prompt.inject` | 高 | 注入系统提示符；激活 `contributes.skills` | 默认拒绝/强确认 | 容易导致行为劫持 |
| `composer.transform` | 中等 | `contributes.composerTransforms` 与 `onComposerTransform` | 安装时确认 | 仅在用户主动执行 Composer 操作后运行。仅接收草稿和可选模型 key，不接收会话历史或单独的附件/文件引用元数据；输入、结果上限均为 100,000 字符并记入审计 |
| `composer.suggest` | 中等 | `pi.composer.suggest` / `pi.composer.clearSuggestion` | 安装时确认 | 仅在草稿为空、且插件声明的轮次仍是当前轮次时，向当前可见会话的输入框占位符层写入一条可忽略的建议。用户按 Tab 采用、Esc 忽略；输入、发送、切换会话、新一轮开始、插件停止、页面重载或窗口关闭都会清除。插件既不能直接发送，也不读取草稿。文本折为单行并截断到 200 字符；存活时间默认 120 秒，上限 10 分钟。记入审计；无法展示时返回 `{ shown: false, reason }` 而不是抛错 |
| `agent.extension` | 高 | 在 agent 进程内运行 `contributes.agentExtensions` 模块 | 显式确认；v1.1 仅限本地导入和开发插件 | 与 agent 自身工具同等权限；插件沙箱不适用（规格 16） |
| `renderer.extension` | 高 | 在宿主渲染进程中执行 `manifest.renderer` 以挂载 UI 插槽；`rendererActions` 与 `rendererCallMethods` 决定该模块可以派发的动作与 `onRendererCall` 方法 | 显式确认；v1.1 仅限本地导入和开发插件，与 `agent.extension` 一致 | 模块与 PI-Desktop 同文档运行，因此插槽是契约而不是沙箱。组件只能派发经过审查的动作词表（`plugin.call`、`composer.insertText`、`composer.readDraft`、`composer.replaceDraft`、`attachments.add` / `list` / `remove`），最多 16 个；`plugin.call` 只能触达调用者自己插件的 `onRendererCall` 方法，最多 32 个。插件卸载时注册会被撤销；自绘弹窗位于插件自己打开的层中 |
| `provider.register` | 高 | `contributes.providers` 成为原生 Provider 列表中的行，归插件所有并在每次加载时按 manifest 刷新 | 显式确认；v1.1 仅限本地导入和开发插件，与 `agent.extension` 一致 | 用户路径拒绝编辑该行（`PROVIDER_OWNED_BY_PLUGIN`）；API key 凭据仍存放在 Host secret store 的常规 provider 引用下 |
| `provider.oauth` | 高 | 已声明 OAuth provider 的 `onProviderOAuth`；宿主渲染的 `pi.providers.oauth.prompt` / `notify` | 显式确认 | `authKind: "oauth"` 需要与 `provider.register` 一起授予。回调只能读取和刷新该 provider 声明自己的加密凭据。Host 会把刷新令牌隔离在渲染进程与 Agent Runtime 之外。宿主代发的网络请求仍需 `net.fetch` 和 `manifest.net.domains`；插件入口代码本身不是操作系统沙箱。每个 provider 声明只保存一个账号；退出登录会清除凭据 |
| `net.fetch` | 高 | `net.fetch` | 默认拒绝 | 限定在 `manifest.net.domains` 之内；列表为空或非法即完全不放行出网（§2A） |
| `net.websocket` | 高 | `pi.net.websocket.connect` / `send` / `close`（套接字由宿主持有；每个插件最多 4 个，帧封顶 1 MiB） | 默认拒绝 | 与 `net.fetch` 一样被限制在 `manifest.net.domains` 之内；被拒绝的主机永远到不了传输层，插件卸载、被禁用或崩溃时每个套接字都会被关闭 |
| `net.anyHost` | 高 | 主机掌握的所有出网路径（`net.fetch`、`net.websocket`、面板 session、远程 HTTP MCP） | 安装时确认 | 对用户自填端点（自建服务器等）解除 `manifest.net.domains` 白名单；云元数据端点始终拒绝；请求时不再弹窗 |
| `shell.openExternal` | 中等 | 打开外部链接 | 首次使用时确认 | 防止网络钓鱼链接 |
| `mcp.server.local` | 高 | 生成清单中声明的 `transport: "stdio"` MCP 服务器 | 默认拒绝 | 运行本地可执行文件；其工具到达代理 |
| `mcp.server.remote` | 高 | 连接 `transport: "http"` MCP 服务器 | 默认拒绝 | 将工具参数发送到第三方端点；非回环 HTTP 不加密 |
| `background.service` | 中等 | 启动 `contributes.services` 并保持插件进程常驻 | 安装时确认 | 受后退监督；在插件页面上可见 |
| `bus.publish` | 中等 | `bus.publish` 声明的主题 | 安装时确认 | 其他插件可以对消息进行操作 |
| `bus.subscribe` | 中等 | `bus.subscribe` 到声明的模式 | 安装时确认 | 可以观察另一个插件的消息 |
| `browser.cdp` | 高 | 对宿主工作面板访客页调用 `pi.browser.*` | 安装时确认 | 访客页边界夹紧到调用插件视图；CDP 走白名单 |
| `desktop.control` | 高 | `pi.desktop.listOperations`、`pi.desktop.invoke` | 安装时确认 | 与本地 MCP 控制平面共用同一份已审查的操作目录，但标记为 plugin-only 的操作例外：六个 `session/collaboration/*` 操作可以经由插件网关调用，却被刻意排除在 MCP 可见目录之外，且没有渲染器变更通道；`dangerous` 操作需要插件传 `confirm: true` **并且**用户在宿主拥有的原生对话框中作答，对话框点名目录中的操作；MCP bearer token 和 Electron 通道名永不暴露 |
| `ui.microphone` | 中等 | 在插件的隔离面板内调用 `navigator.mediaDevices.getUserMedia({ audio: true })` | 安装时确认 | 仅音频；摄像头和其他所有设备权限仍被拒绝；插件拿不到原生句柄或宿主密钥 |
| `audio.capture.background` | 高 | `pi.audio.getInputDevices`、`openInput`、`closeInput`、`getCaptureState`、`onInputFrame` / `offInputFrame`（已注册在插件 API 中并由该权限把关；两个同步注册辅助函数同步抛出带错误码的拒绝） | 默认拒绝 | 设备由宿主持有；只交换 PCM16 帧，没有设备句柄或 `MediaStream`。宿主目前还没有设备后端，所以获得授权的调用会以带错误码的 `UNSUPPORTED` 拒绝并记入审计；不会打开任何设备 |
| `audio.playback.background` | 中等 | `pi.audio.openOutput`、`writeOutput`、`stopOutput`、`closeOutput`（已注册在插件 API 中并由该权限把关） | 安装时确认 | 播放队列由宿主持有，仅 PCM16。宿主目前还没有设备后端，所以获得授权的调用会以带错误码的 `UNSUPPORTED` 拒绝并记入审计；不会打开任何设备 |
| `keyboard.globalShortcut` | 中等 | `pi.keyboard.registerGlobalShortcut`、`unregisterGlobalShortcut`、`listGlobalShortcuts`；`contributes.globalShortcuts` | 安装时确认 | 宿主持有 Electron 的 `globalShortcut`；快捷键只能运行插件自己的命令；冲突会被拒绝（`SHORTCUT_CONFLICT` / `SHORTCUT_UNAVAILABLE` / `INVALID_ACCELERATOR` / `LIMIT_EXCEEDED`，每个插件最多 8 条）；卸载、禁用或崩溃时释放 |
| `models.list` | 中等 | `pi.models.list` | 安装时确认 | 仅已就绪的 provider/model 行；不含密钥 |
| `project.create` | 高 | `pi.project.create` 及会话导入中的显式 `projectId` | 安装时确认 | 创建或复用持久项目记录但不激活工作区；只有显式传入 id 的导入会绑定项目 |
| `session.read` | 高 | `pi.session.getLlmContext` | 安装时确认 | 仅限进行中的工具会话；带 compaction 的投影（D019 / D336） |
| `session.autoTitle` | 高 | `pi.session.getAutoTitleContext`、`pi.session.setAutoTitle` | 安装时确认 | 仅限默认标题会话的首条用户提示（≤1,000 字符）和首条助手回复（≤500 字符）；标题通过比较并设置写入；不授予转录读取 |
| `session.import` | 高 | `pi.session.import`、`pi.session.importBatch` | 安装时确认 | 只能导入插件声明来源；有大小和频率限制 |
| `session.read.own` | 中等 | `pi.session.list`、`pi.session.get`、`pi.session.listMessages` | 安装时确认 | 只能读取本插件导入的会话；不能跨插件访问 |
| `session.update.own` | 中等 | `pi.session.rename` | 安装时确认 | 只能重命名本插件拥有的活动导入会话 |
| `session.delete.own` | 高 | `pi.session.delete` | 安装时确认 | 只能回收或清除本插件导入的会话；有频率限制 |
| `usage.read` | 中等 | `pi.usage.listTurns` | 安装时确认 | 已完成 turn 事实行的只读列举（每回合 token 计数与标识符，keyset 分页）；不含消息正文，无写路径 |
| `agent.complete` | 高 | `pi.agent.complete` | 安装时确认 | 宿主代发一次性补全；消耗用户额度；`includeSessionContext` 还需要 `session.read` |
| `speech.adapter.register` | 高 | `pi.speech.registerAdapter` / `unregisterAdapter` | 安装时确认 | 注册语音协议。handle 留在插件进程；HTTP 计划由宿主用绑定密钥代发且必须同 origin |

「默认策略」一列是预期策略，当前宿主并未按权限逐项执行：安装与更新审核会列出全部
声明的权限（更新新增的会标出），只要授权缺少任何一项声明的权限，安装器就会拒绝
（`PLUGIN_PERMISSION_DENIED: missing grant for <permission>`）。首次使用时不会再次
询问——`clipboard.*` 与 `shell.openExternal` 只检查已保存的授权。自动更新会跳过新增
权限的更新（§5）。

## 2A. 权限是开关，manifest 承载范围

有两种能力光靠一个权限名说不清楚：名字负责回答「插件能不能做」，
manifest 里的字段负责回答「能做到多远」。两个字段都由主机强制执行、
在权限旁展示给用户，并在安装时校验。

| 字段 | 限定的范围 | 缺失或为空时 |
|---|---|---|
| `net.domains` | 主机掌握的每一条出网路径：面板 session、`pi.net.fetch`、`pi.net.websocket`、远程 HTTP MCP 端点 | 完全不放行出网，无论 `net.fetch` 是否声明 |
| `fs.read` / `fs.write` / `fs.delete` | 该文件模式可以触碰哪些路径 | 没有常驻可达范围；每次访问都落到确认弹窗 |

字段缺失时一律 fail closed，这正是它们可以省略的原因：manifest 什么都不说，
就什么都不授予。参见
[04-plugin-security.md](/zh-CN/spec/07-plugins/04-plugin-security) §6 与 §8.1，以及 ADR 0088。

两者还互相牵连。`fs.read` 之所以可以声明整棵树，是因为读取只有在字节能离开时
才变成泄露，而 `net.domains` 已经把这一半关上了。`fs.write` 和 `fs.delete`
本身就有破坏性，所以整棵树的模式（`**`、`**/*`、`*/**`、`./*`）在这两种模式下
无法通过清单校验。

## 2B. 删除

`fs.delete` 是唯一一种「重跑一遍插件也补不回来」的文件操作，因此比其他模式多三道约束：

1. **两档。** `own: true` 允许插件删除自己写过的文件 —— 主机在插件数据目录里
   维护一份写入台账 —— 无需范围、无需弹窗；用户之后改过的文件会掉出台账。
   删别的东西必须声明 `scope`，范围之外要问用户。
2. **系统回收站。** 删除走 `shell.trashItem`，不走 `rm`，并且永不递归：
   非空目录直接拒绝而不是清空。主机不为此保留用户数据的任何副本。
3. **速率刹车。** 每个插件每滚动 60 秒 50 次删除。超过之后问用户一次，
   理由写的是速率而不是路径 —— 因为 `recursive: false` 只能约束单次调用，
   约束不了 `glob` 加一个循环。

## 3. 权限依赖

- 加载面板条目需要 `ui.panel`
- 贡献工作面板视图需要 `ui.view`；它与 `ui.panel` 相互独立，
  因此插件可以只提供停靠视图而没有独立窗口
- `ui.view` 也覆盖 `pi.ui.revealView`：在某个会话的工作面板里显示插件自己的视图；
  跟随选中会话（`pi.session.getActive`、`session:activated`）不需要权限
- 需要`agent.tool.register`来贡献agent工具
- 当 `fs.write` 存在时，建议同时声明 `fs.read`
- `manifest.fs.<mode>` 需要对应的 `fs.<mode>` 权限；没人能用的范围会导致校验失败，
  而不是被悄悄忽略
- `fs.requestDirectory`（`userSelected` root）由 `fs.read` 把关；在用户选中的目录里
  写入或删除仍然需要 `fs.write` / `fs.delete`
- 缺少权限的贡献未通过清单验证
  （`themes`、`views`、`providers` 及 OAuth provider、`agentExtensions`、
  `composerTransforms`、`globalShortcuts`、`windowAppearance`、`mcpServers`、
  `services`、`bus`）；`skills` 是例外，在加载时跳过；缺少 `ui.settings` 和
  `ui.theme` 的 `scenicThemes` 不会显示（参见
  [02-plugin-manifest-schema.md](/zh-CN/spec/07-plugins/02-plugin-manifest-schema) §7)
- 生命周期与状态事件不需要权限：`workspace:changed`、`appearance:changed`、
  `session:modelChanged`、`session:turnEnded`、`session:activated` 和
  `plugin:settingsChanged` 走既有的插件事件通道，
  订阅未知的事件名也不会报错

## 3A. Plan 操作状态规则

插件工具默认在 Plan/Goal 中隐藏并拒绝。运行时工具注册可通过非空 `planSafeActions`
显式加入，只有 `args.action` 位于该列表时才允许执行。有 schema action enum 时会校验取值。
清单描述符应与运行时注册保持一致，真正执行的工具由运行时注册决定。
`risk: "low"`、会话授权和 `auto` 不能代替该声明。宿主策略与插件执行器都会校验，
执行器对越界 action 返回 `PERMISSION_DENIED`。该列表是作者的只读承诺，不是副作用沙盒（ADR 0211）。

## 4. 权限显示副本

下表文案取自 en 与 zh-CN 语言包（`packages/i18n/src/locales/`）中的
`plugins.permissions.*`。安装与更新审核显示该标签，并在其下显示对应的
`plugins.permissionHelp.*` 说明；插件页以标签 chip 显示。语言包没有条目时，
标签回退为原始权限名。声明的文件范围显示在已安装插件行的「文件」一栏，
所以「修改文件」后面紧跟着那份清单。

| 权限 | 英文文案 | zh-CN 文案 |
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

以下权限目前没有语言包条目，显示为原始权限名：
`ui.settings`、`session.import`、`session.read.own`、`session.update.own`、`session.delete.own`、`ui.view`、`project.create`。

## 5. 添加升级权限

如果升级时出现新权限：

1. 计算差异
2.强制用户确认
3. 如果没有确认，请取消升级或禁用新功能（建议取消升级）

## 6. 运行时检查伪代码

```ts
assertPermission(pluginId, perm) {
 if (!granted(pluginId, perm)) throw ERROR_PERMISSION_DENIED
}
```

每个主机 API 入口点必须首先置位。文件类入口点之后还要再过三道门，
顺序固定 —— 后面的门只能拒绝，永远不能放宽：

```ts
assertFsAccess(pluginId, mode, requestedPath, sessionId) {
 assertPermission(pluginId, `fs.${mode}`)              // declared AND granted
 full = realpathWithinRoot(root(pluginId, mode, sessionId), requestedPath)
 if (!full) throw NOT_FOUND | INVALID_ARGUMENT         // symlinks resolved first
 if (isDenied(full) || isHostReserved(full)) throw ERROR_PERMISSION_DENIED
 if (!inScope(full, declaredScope(pluginId, mode))) await confirmWithUser(...)
}
```
`workspace` 根是调用该调用的工具会话所属的项目，面板调用没有工具会话，回退到可见工作区（ADR 0266）。

## 7. 验收

1. 未经授权的API调用失败
2. 权限副本在安装 UI 中可见，且文件权限会同时显示它声明的范围
3.添加权限提示用户的升级
4. 声明范围之外的写入或删除会弹窗，拒绝会以 `PERMISSION_DENIED` 记入审计
5. 在整棵树的读取范围下，`.env` 与 `.git/**` 仍然不可读，也不会出现在
   `fs.glob` 的结果里
6. root 之内指向外部的软链不能把访问带出去
7. 删除进系统回收站、拒绝非空目录，并在滚动一分钟内超过 50 次后被打断
8. 只声明旧权限名 `fs.*.workspace` 的插件会失去写入与删除的可达范围，
   插件页面会把这件事说出来
