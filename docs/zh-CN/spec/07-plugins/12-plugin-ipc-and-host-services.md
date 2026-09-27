# 12. 插件 IPC 和主机服务

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/12-plugin-ipc-and-host-services) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 目标

完成与插件相关的主机服务和 UI IPC，以便实现不依赖于临时约定。

## 2. 主进程服务

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

### 插件域
- `plugin/list`
- `plugin/detail`
- `plugin/loadDev`
- `plugin/reload` — 解析注册的插件路径，在 Electron 中重新加载它
  main，并刷新开发插件权限上限
- `plugin/installFromPath` ✅
- `plugin/installFromPackage` ✅
- `plugin/enable`
- `plugin/disable`
- `plugin/uninstall`
- `plugin/reload`
- `plugin/getLogs`
- `plugin/getPermissions`
- `plugin/grantPermissions`
- `plugin/revokePermissions`
- `plugin/openDataDir`
- `plugin/openInstallDir`
- `plugin/openPanel`
- `plugin/setAutoUpdate`
- `plugin/themes` ✅ — 每个加载的插件的清理主题 CSS，用于主题
  选择器和注入的 `<style>` 元素
- `plugin/services` ✅ — 居民服务状态 (`starting` | `running` |
  `stopped` | `failed`) 加上重新启动计数，用于插件页面芯片

### commandPalette 域
- `commandPalette/search`
- `commandPalette/execute`
- `commandPalette/listRecent`

### 市场域（已实现）
- `market/search`
- `market/getDetail`
- `market/install`
- `market/checkUpdates`
- `market/applyUpdates`
- `market/listProviders`（目前为单一官方提供商）

## 4. 事件（主 → 渲染器）

- `plugin/event/changed`（installed/enabled 更改）
- `plugin/event/loadError`
- `plugin/event/permissionRequired`
- `market/event/updateAvailable`

附带的 `pluginChanged` 事件带有 `reason`，以便渲染器可以决定
重新获取的内容：`install`、`loadDev`、`enable`、`disable`、`uninstall`、`crash`、
`service`、`market.install`、`market.applyUpdates`。 `service` 在每个
监管过渡是其中最便宜的——只需要服务列表
重新加载。

## 4. 1 事件（主机→插件进程）

代理还将单向帧推送到插件的 `utilityProcess`：

```text
{ t: "event", event: "bus.message", subscriptionId, message }
```

没有回复帧，也没有背压：交付是一劳永逸的，所以
楔入的订阅者无法阻止发布者。孩子分派给处理程序
注册 `subscriptionId` 和任何 `pi.events.on` 侦听器；一次投掷
处理程序已记录，永远不会致命。这与最终使
`pi.events.on` / `off` 真实（参见
[03-plugin-api.md](/zh-CN/spec/07-plugins/03-plugin-api) §5)。

## 5. ContributionRegistry 行为

### 注册
- 密钥必须是唯一的
- 插件命令共享前缀：`plugin.<pluginId>.<commandId>`
- 插件工具前缀策略：`plugin_<pluginIdSafe>_<toolName>`（在实现中修复）

### 查询
- 命令面板仅查询已启用+加载成功的贡献
- Agent 查看已注册的工具；无论风险如何，Plan 均不会收到任何插件工具
  或授予状态

### 注销
- 删除 disable/unload/uninstall 上的所有内容，包括停止驻留
  服务、断开 MCP 服务器、删除总线订阅以及删除
  来自选择器的插件主题

## 6. RuntimeBroker 调用链

插件 API 调用：

```text
plugin runtime
 → RPC to PluginRuntimeBroker
 → PermissionGateway.check
 → Host service execute
 → audit log
 → response
```

## 7. PanelHost交互

- 打开面板时创建独立视图
- 传入pluginId /主题令牌
- 关闭时销毁视图和消息订阅。需要 `webContents` 身份的清理必须在窗口销毁前复制该 id；`closed` 处理程序不得在已销毁的窗口上读取 `webContents`，否则宿主会抛出未捕获的 `TypeError: Object has been destroyed`。
- preload 通过 `pluginBridge.getDroppedFilePath(file)` 暴露文件路径，但不向页面暴露 Node。面板可以把路径传给 `fs.registerDropped`；宿主会一次性消费发送方最近的拖拽记录，为 `fs.stat` / `fs.readRange` 签发单文件读取授权。

面板桥接文件通道的权限如下：

| 通道 | 所需权限 |
|---|---|
| `fs.readText`、`fs.stat`、`fs.readRange`、`fs.readPreview`、`fs.openDefault`、`fs.reveal`、`fs.glob`、`fs.list` | `fs.read` |
| `fs.registerDropped` | `fs.read` 加真实拖拽手势 |
| `fs.writeText` | `fs.write` |

## 8. 故障隔离

- 插件API超时：返回TIMEOUT
- 运行时崩溃：标记load_error，清理贡献
- 面板崩溃：只关闭面板，不卸载插件（可提示重新加载）

**实施（2026-07-29，ADR 0008）：** 经纪人居住在
`electron/main/plugin-runtime.ts` 和每个插件调用都是对
插件自己的 `utilityProcess`。预算：加载 15 秒，生命周期挂钩 5 秒，命令 30 秒，
工具 110 秒（根据 host-core 的 120 秒工具预算）。进程退出经纪人
使用 `PLUGIN_CRASHED` 拒绝挂起的调用，取消注册该插件的命令
和工具，关闭其面板，写入 `plugin.crash` 审核条目，并发出
toast 加上 `pluginChanged` 到渲染器。

## 9. 验收

1.插件列表IPC有效
2.命令面板IPC可以执行插件命令
3. Start/stop 触发贡献 registration/deregistration
4. 市场 IPC 在模拟提供商下端到端运行（后来的里程碑）

## 附录：代理工具调度协议（M5实现）

插件代理工具在桌面运行程序 (Electron main) 中执行，而
权限门和结果信封保留在 host-core 中：

1.模型调用`plugin_<pluginIdSafe>_<toolName>`； sidecar 转发它
   像任何内置工具一样托管 `tools.execute`。
2. host-core 首先解析持久操作模式。在 Agent 中，它运行
   正常权限流程（风险、会话授予、120 秒超时），然后发出
   通知 `plugins.execute`
   `{ executionId, sessionId, toolCallId, toolName, args }`。
3. Plan 调用在主机策略步骤失败并显示 `PLUGIN_DISABLED_IN_PLAN`；他们
   永远不会达到 Electron 或插件运行时。 Agent 呼叫继续
   Electron主要执行注册的插件工具JS并通过RPC应答
   `plugins.resolveExecution` `{ executionId, ok, content, errorCode? }`。
4. host-core 解析待执行并返回一个标准
   `ToolsExecuteResult` 到 sidecar。调度超时映射到
   `TOOL_TIMEOUT`； unknown/unloaded 工具映射到 `TOOL_NOT_FOUND`。

面向模型的注册表根据提示获得插件工具：已注册主要通道
defs（`fullName`、描述、JSON 架构参数）到 `agent.prompt`，以及
运行时将它们保存在延迟目录中，而不是序列化每个
架构到第一个请求中。该模型通过加载匹配的插件工具
本地 `ToolSearch` 工具；下一轮接收选定的模式并
然后使用上面相同的主机 permission/dispatch 路径。协议涵盖
烟雾场景 E2E-024 和运行时加载场景 E2E-008a。

从插件的 MCP 服务器发现的工具会进入相同的注册表
`plugin_<pluginIdSafe>_<serverId>_<toolName>`，所以上面的步骤1-4不变；
只有步骤 3 内部有所不同，转发到 MCP 客户端而不是插件 JS。

技能使用单独的、更简单的路径。目录（id、名称、描述）是一部分
在基本系统提示符中，`Skill` 模式本身被推迟到后面
`ToolSearch`，其主体由 Electron main 的本地 `Skill` 工具获取
直接服务——sidecar从不保存技能文本和技能文档
仅当模型需要时才到达模型 (D174/D185)。
