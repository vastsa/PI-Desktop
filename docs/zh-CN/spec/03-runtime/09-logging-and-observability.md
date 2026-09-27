# 09. 日志记录和可观测性

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/09-logging-and-observability) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 目标

1.快速诊断故障
2. 审核敏感的 tool/plugin 操作
3.避免泄露秘密
4. 保持 MVP 简单（本地文件优先）

## 2. 日志级别

- `debug`
- `info`
- `warn`
- `error`

默认运行时级别：

- 开发者：`debug`
- 发布：`info`

## 3. 通道

| 通道 | 内容 | 位置 |
|---|---|---|
| app | 启动、ipc、窗口、进程监控 | `~/.pi-desktop/logs/app/<category>.log` |
| host | rust host-core 事件（stderr 捕获） | `~/.pi-desktop/logs/host/<category>.log` |
| agent | pi sidecar turn/provider 事件（stderr 捕获） | `~/.pi-desktop/logs/agent/<category>.log` |
| audit | permissions/tools/plugins 敏感操作 | host-core SQLite `audit_log` 表 |
| plugin | 每个插件的日志 | `~/.pi-desktop/plugins/logs/<id>.log` |

注意事项：

- tool/plugin/MVP/`debug` 是 Electron 主程序写入的 NDJSON 文件
  `Logger`（`apps/desktop/electron/main/logger.ts`）； host/agent stderr 行
  被打包到他们频道的记录中。
- 审核通道存储在 SQLite（归 host-core、D006 所有）中，而不是
  平面文件：它需要可查询性和比调试日志更长的保留时间。
  `logs folder` 诊断仍然适用于三个文件通道。

### 3a. 类别路由

三个进程通道是目录，而不是聚合文件。主要
进程将每条记录写入 `<channel>/<category>.log`，因此大容量
可以独立检查会话、工具、计时和提供商记录。

应用程序渠道使用以下类别：

- `lifecycle` — 启动、关闭和应用程序监控
- `session` — 提示、回合、会话生命周期和压缩
- `tool` — 工具 start/end 事件
- `permission` — 权限请求和决定
- `plugin` — 插件加载、服务和插件工具执行
- `provider` — provider/model 发现和缓存失败
- `persistence` — 成绩单和发件箱持久性失败
- `updater` — 电子更新器诊断
- `diagnostics` — 阻止导航、菜单和模板诊断
- `runtime` — host/sidecar 生命周期事件
- `timing` — 启动阶段和更新检查耗时

主机和代理stderr在线路时被归为同一类别
包含可识别的子系统标记。子进程 stderr 中的时间线总是路由到
`host/timing.log` 或 `agent/timing.log`；未知子输出到那个
频道的 `runtime.log`。Electron 主进程把启动、剪贴板和更新检查
打点写到 `app/timing.log`。每条记录都包含其 `category` 字段。

不再写入平面 `app.log`、`host.log` 和 `agent.log` 名称。
现有的旧文件在布局转换期间保持不变。

## 4. 必填字段

每个结构化日志行应包括：

```ts
type LogRecord = {
  ts: string
  level: "debug" | "info" | "warn" | "error"
  channel: string
  category: string
  message: string
  traceId?: string
  sessionId?: string
  turnId?: string
  toolCallId?: string
  pluginId?: string
  code?: string
  data?: unknown
}
```

格式化 MVP：NDJSON 文件。

## 5. 必须记录的内容

### 始终记录
- 应用程序 boot/shutdown
- host/agent 生成 + 握手结果
- 会话 create/delete
- 提示 accepted/aborted
- 工具 start/end
- 许可 request/decision/timeout
- Plan 工件创建（唯一路径、SHA-256、字节大小）、approval/expiry/
  拒绝、执行转换和启动中断
- shell ID/effective 方言、availability/fallback 或更改选择失败、流
  字节计数、超时和进程树关闭
- 插件 enable/disable/load/error
- 工具准入拒绝、队列深度、活动类预算和 shell 生成
  资源耗尽

### 绝不记录
- API 密钥/原始秘密
- 完全安全的存储有效负载
- 审计中大量读取不必要的完整文件内容（使用 hashes/previews）

## 6. 脱敏规则

1. 与 `/token|secret|password|api[_-]?key/i` 匹配的键名做脱敏处理
2. Authorization 标头做脱敏处理
3. 工具参数预览被截断（例如 2KB）
4. 审计中对长命令输出做计数/截断；stdout/stderr 数据块绝不整体写入
   常规通道

## 7. 追踪关联

尽可能为每个用户可见的操作使用一个 `traceId`：

- 提示→turnId
- 工具调用 → toolCallId
- 权限流共享 toolCallId/requestId

Renderer、Electron、主机、代理应传播这些 ID。

## 7a. 延迟分段 (D183)

缓慢的代理转动在该工具内几乎从不慢。等待属于
三个阶段之一，每个阶段都单独记录，以便可以告诉他们
不加猜测地分开：

| 舞台 | 哪里 | 领域 |
|---|---|---|
| 批准 | host-core `tools.execute` | `permission_wait_ms` |
| 工具体 | host-core 工具实现 | `execute_ms`（审核中的 `durationMs`） |
| 主机簿记 | host-core（工作区解析、锁定、工件、审核） | `overhead_ms` |
| 飞行前指令 | sidecar，`tools.execute` 之前的路径范围链 | `instructionResolveMs` |
| 房东往返费用包括IPC | sidecar 周围 `tools.execute` | `hostRttMs` |
| 提供商优先令牌 | sidecar，请求 → `message_start` | `providerWaitMs` |
| 提供商流媒体 | sidecar、`message_start` → `message_end` | `streamMs` |

- host-core 在 `host` 通道上的每次调用发出一条 `tool timing` 行
  `prompted`、`permission_wait_ms`、`execute_ms`、`overhead_ms`、`total_ms`、
  和 `outcome`（`ok` / `error` / `denied`）；相同的字段被持久化
  `tool_execute` / `tool_denied` 审核行。
- sidecar 写入 grepable `[timing] kind=<tool|model|subagent> key=value`
  到 stderr 的行，Electron `Logger` 将其包装到 `agent` 通道中。
  设置 `PI_DESKTOP_TIMING=0`（或 toolCallId/requestId/Electron）来抑制它们。
- `hostRttMs` 减去同一 `toolCallId` 的主机的 `total_ms` 是
  stdio/IPC 成本； `providerWaitMs` 覆盖 pi-ai 自己的重试退避，因此
  烧毁重试的提供程序会出现在那里，而不是作为一个缓慢的工具。
- `instructionResolveMs` 测量路径范围指令预检和
  不属于指挥机构。 `instructionCacheHit=true` 识别
  相同提示目录声明； `instructionFallback=base` 识别
  运行时的基链继续超时或解析器故障。
- 失败或中止的回合仍会发出 `kind=model` 行和结果，因此
  从未产生代币的回合仍然是可衡量的。
- 一条 `kind=subagent` 行关闭每个 `Task` 调用（D201、ADR 0062）
  `agent`、`toolCallId`、`sessionId`、`turnId`、`provider`、`model`、`status`、
  失败时为 `turns`、`toolCalls`、`durationMs` 和 `errorCode`。代表行
  在转录中归因，但他们的工具和模型线没有，所以
  这就是并行扇出的区别：相同的 `turnId`，每行一行
  委托，每个委托都有自己的提供商和挂钟成本。

助理成绩单还保留成功的流持续时间为
`UiMessage.responseDurationMs`。渲染器将其与提供商报告的相结合
输出令牌以显示 `tokens/s` 中的生成速度；这是一个演示
相同 `streamMs` 间隔的投影，而不是第二个定时源。工具
行带有单独的上下文估计 argument/result 足迹
检查，而提供商 input/output 的准确使用仍然具有权威性。

Plan 和 shell 记录使用相同的 `sessionId`、`turnId` 和 `toolCallId`
相关字段。工件日志仅包含下的唯一相对路径
`.pi/plan/`、哈希值和大小； shell 日志包括目录 ID 和方言，
绝不是来自渲染器的任意可执行命令行或路径哈希。

## 7b. 启动与更新器计时

首个窗口变慢几乎从来不是单个数字能解释的。请通过 `app/timing.log` 中可 grep 的
`[timing] kind=<boot|updater>` 行来归因：

| kind | phase | 测量内容 |
|---|---|---|
| boot | `when-ready` | 进程模块加载 → Electron `app.whenReady` |
| boot | `host` | host-core 生成 + 握手（`spawnedMs`、`handshakeMs`） |
| boot | `sidecar` | agent sidecar 生成 + `sidecar.configure` |
| boot | `plugin-restore` | 每个已启用插件的 `utilityProcess` 加载 |
| boot | `window-created` / `window-loaded` / `window-shown` | BrowserWindow 分配、`loadFile`、`ready-to-show` |
| boot | `renderer-bootstrap` | 渲染器 settings/snapshot IPC 直到 `ready` |
| updater | `check-start` / `check-done` | GitHub 更新源检查，附带 `outcome=ok\|timeout\|error` |

- `elapsedMs` 从进程启动开始计时；`durationMs` 只计该阶段本身。
- 自动更新检查在首个窗口存在之后才调度，不在启动路径上等待，并把等待时间限制
  在 8s，使 Chromium 约 60s 的 GitHub 超时无法把更新器状态钉在 `checking` 上。

## 8. 面向用户的诊断

MVP 提供：

1. 应用内错误文本及代码
2.“打开日志文件夹”命令
3.可选复制错误详细信息（代码+traceId）

不在 MVP 中：

- 远程遥测管道
- 云崩溃分析（可以在同意后添加）

## 9. 保留

- app/host/agent 类别日志：大小上限轮换 — 轮换每个类别
  文件大小为 5 MB，在其旁边保留 2 个旋转文件（`<category>.1.log`、
  `<category>.2.log`）
- 审核日志（SQLite）：与数据库一起保留；比调试日志长
- 轮换决不能让调用者失败；磁盘故障被吞噬
- 控制台镜像是尽力而为：关闭的 stdout/stderr（`EPIPE`/`EIO`，常见于 Linux
  AppImage 以及没有 TTY 的 GUI 启动）会被吞掉，绝不会变成主进程未捕获异常。
  Main 也会忽略 `process.stdout` / `process.stderr` 上的这类流错误，以免其他
  写入触发 Electron 的未捕获异常对话框。

## 10. 验收

1. 失败的工具调用可以通过toolCallId跨日志追踪
2. 在正常流程中，秘密永远不会出现在日志文件中
3. 可从 app/command 调色板打开日志文件夹
4. 工具调用缓慢可归因于批准、执行或提供商
   仅从日志中（D183）
5. 主机资源事件暴露了 active/queued 工具预算和单个
   重新启动生成而不是重复的陈旧管道错误
6. Plan 启动中断和 shell changed-selection/timeout/process 中止
   可以从session/turn/tool-call相关性和稳定误差进行诊断
   代码
7. 当 stdout 是断开的管道时，日志或控制台镜像绝不能让主进程崩溃
