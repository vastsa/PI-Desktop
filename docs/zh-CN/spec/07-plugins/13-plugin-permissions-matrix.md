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
| `agent.extension` | 高 | 在 agent 进程内运行 `contributes.agentExtensions` 模块 | 显式确认；v1.1 仅限本地导入和开发插件 | 与 agent 自身工具同等权限；插件沙箱不适用（规格 16） |
| `provider.register` | 高 | `contributes.providers` 成为原生 Provider 列表中的行，归插件所有并在每次加载时按 manifest 刷新 | 显式确认；v1.1 仅限本地导入和开发插件，与 `agent.extension` 一致 | 用户路径拒绝该行（`PROVIDER_OWNED_BY_PLUGIN`）；凭据仍存放在 Host secret store 的常规 provider 引用下；暂不启用 `oauth` 声明 |
| `agent.permission.deny` | 中等 | `contributes.permissionDeny` 并入宿主 deny-first 叠加 | 安装时确认 | 只能 deny；不能删除用户规则或增加 allow。空 `{}` 仍需要该权限。不在 `HIGH_RISK_PERMISSIONS` 中（D433 / ADR 0267） |
| `net.fetch` | 高 | `net.fetch` | 默认拒绝 | 限定在 `manifest.net.domains` 之内；列表为空或非法即完全不放行出网（§2A） |
| `net.websocket` | 高 | `pi.net.websocket.connect` / `send` / `close`（套接字由宿主持有；每个插件最多 4 个，帧封顶 1 MiB） | 默认拒绝 | 与 `net.fetch` 一样被限制在 `manifest.net.domains` 之内；被拒绝的主机永远到不了传输层，插件卸载、被禁用或崩溃时每个套接字都会被关闭 |
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
| `session.import` | 高 | `pi.session.import`、`pi.session.importBatch` | 安装时确认 | 只能导入插件声明来源；有大小和频率限制 |
| `session.read.own` | 中等 | `pi.session.list`、`pi.session.get`、`pi.session.listMessages` | 安装时确认 | 只能读取本插件导入的会话；不能跨插件访问 |
| `session.update.own` | 中等 | `pi.session.rename` | 安装时确认 | 只能重命名本插件拥有的活动导入会话 |
| `session.delete.own` | 高 | `pi.session.delete` | 安装时确认 | 只能回收或清除本插件导入的会话；有频率限制 |
| `agent.complete` | 高 | `pi.agent.complete` | 安装时确认 | 宿主代发一次性补全；消耗用户额度；`includeSessionContext` 还需要 `session.read` |

## 2A. 权限是开关，manifest 承载范围

有两种能力光靠一个权限名说不清楚：名字负责回答「插件能不能做」，
manifest 里的字段负责回答「能做到多远」。两个字段都由主机强制执行、
在权限旁展示给用户，并在安装时校验。

| 字段 | 限定的范围 | 缺失或为空时 |
|---|---|---|
| `net.domains` | 主机掌握的每一条出网路径：面板 session、`pi.net.fetch`、远程 HTTP MCP 端点 | 完全不放行出网，无论 `net.fetch` 是否声明 |
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
- 需要`agent.tool.register`来贡献agent工具
- 贡献 `permissionDeny`（包括空对象）需要 `agent.permission.deny`
- 当 `fs.write` 存在时，建议同时声明 `fs.read`
- `manifest.fs.<mode>` 需要对应的 `fs.<mode>` 权限；没人能用的范围会导致校验失败，
  而不是被悄悄忽略
- `fs.requestDirectory`（`userSelected` root）由 `fs.read` 把关；在用户选中的目录里
  写入或删除仍然需要 `fs.write` / `fs.delete`
- 缺少权限的贡献未通过清单验证
  （`themes`、`mcpServers`、`services`、`bus`、`permissionDeny`）； `skills` 是例外，并且是
  相反，在加载时跳过（参见
  [02-plugin-manifest-schema.md](/zh-CN/spec/07-plugins/02-plugin-manifest-schema) §7)
- 生命周期与状态事件不需要权限：`workspace:changed`、`session:modelChanged`、
  `session:turnEnded` 和 `plugin:settingsChanged` 走既有的插件事件通道，
  订阅未知的事件名也不会报错

## 3A。 Plan 操作状态规则

每个 `agentTools` 贡献都会在 Plan 中被拒绝，无论此矩阵的值如何
风险或违约政策。 `agent.tool.register` 授权注册
Agent，在 Plan 中不可见。主机返回 `PLUGIN_DISABLED_IN_PLAN`
直接 Plan 调用并记录拒绝。仅插件工具符合资格
在同一个 Agent 被批准进入 Agent 模式后。

## 4. 权限显示副本

英文是主要副本。 zh-CN 列保存本地化的示例字符串。
文件权限从不单独展示：声明的范围会渲染在它旁边，
所以「修改它列出的文件」后面紧跟着那份清单。

| 许可 | 英文副本 | zh-CN 示例 |
|---|---|---|
| `fs.read` | Read the files it lists | 读取它列出的文件 |
| `clipboard.read` | Read the current clipboard and retained history | 读取当前剪贴板和保留的历史 |
| `fs.write` | Modify the files it lists | 修改它列出的文件 |
| `fs.delete` | Delete the files it lists, to the trash | 删除它列出的文件（进回收站） |
| `notify` | 显示应用内和本机通知 | 显示应用内和系统通知 |
| `agent.tool.register` | 为AI Agent提供可执行工具 | 向AI Agent提供可执行工具 |
| `agent.prompt.inject` | 调整代理指令 | 调整智能体指令 |
| `agent.extension` | 在 agent 内运行代码 | 在 agent 内运行代码 |
| `agent.permission.deny` | Add always-deny permission rules | 添加始终拒绝的权限规则 |
| `net.fetch` | 访问网络 | 访问网络 |
| `shell.openExternal` | 打开外部链接 | 打开外部链接 |
| `ui.theme` | 提供一个主题 | 提供主题 |
| `ui.settings` | Add a sandboxed Settings entry in Extensions | 在“扩展”中添加沙盒设置项 |
| `ui.window.appearance` | 设置窗口背景 | 设置窗口背景 |
| `mcp.server.local` | 运行本地 MCP 服务器 | 运行本地 MCP 服务 |
| `mcp.server.remote` | 到达远程 MCP 服务器 | 连接远端 MCP 服务 |
| `background.service` | 保持后台服务运行 | 保持后台服务运行 |
| `bus.publish` | 向其他插件发送消息 | 向其他插件发送消息 |
| `bus.subscribe` | 接收来自其他插件的消息 | 接收其他插件的消息 |
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
 assertPermission(pluginId, `fs.${mode}`)              // 已声明且已授予
 full = realpathWithinRoot(root(pluginId, mode, sessionId), requestedPath)
 if (!full) throw NOT_FOUND | INVALID_ARGUMENT         // 先解析软链
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
