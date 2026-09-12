# 09. 日志记录和可观测性

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/09-logging-and-observability) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

## 1. 目标

1. 快速诊断故障。
2. 审计敏感的工具和插件操作。
3. 避免泄露秘密。
4. 保持 MVP 本地优先，并让正常运行保持安静。

## 2. 日志级别

- `debug`
- `info`
- `warn`
- `error`

默认运行时级别：

- 开发：`debug`
- 发布：`info`

## 3. 通道

| 通道 | 内容 | 位置 |
|---|---|---|
| app | 启动、IPC、窗口、进程监控 | `~/.pi-desktop/logs/app/<category>.log` |
| host | Rust host-core 事件（stderr 捕获） | `~/.pi-desktop/logs/host/<category>.log` |
| agent | pi sidecar 事件（stderr 捕获） | `~/.pi-desktop/logs/agent/<category>.log` |
| audit | 敏感的权限、工具和插件操作 | host-core SQLite `audit_log` 表 |
| plugin | 每个插件的日志 | `~/.pi-desktop/plugins/logs/<id>.log` |

`app`、`host` 和 `agent` 是由 Electron 主进程 `Logger`
（`apps/desktop/electron/main/logger.ts`）写入的 NDJSON 文件。host 和
agent 的 stderr 行会被包装成对应通道的记录。audit 通道由 host-core
独占写入 SQLite，因此可以独立于轮换的诊断文件进行查询。

### 3a. 类别路由

三个进程通道是目录，而不是聚合文件。主进程调用点明确选择类别。
host 和 agent stderr 使用标记进行分类；无法分类的子进程输出使用
`runtime`。

应用程序类别包括：

- `lifecycle` — 启动、关闭和应用监控
- `session` — 提示、回合、会话生命周期和压缩
- `tool` — 工具 start/end 事件
- `permission` — 权限请求和决定
- `plugin` — 插件加载、服务和插件工具执行
- `provider` — provider/model 发现、重试和缓存失败
- `persistence` — 成绩单和发件箱持久化失败
- `updater` — 更新器诊断和错误
- `diagnostics` — 阻止导航、菜单和模板诊断
- `runtime` — host/sidecar 生命周期及未分类的子进程输出

不存在独立的 `timing` 类别。较早运行生成的 timing 文件保持不变，
但当前代码不会创建或追加这些文件。旧的 `app.log`、`host.log` 和
`agent.log` 文件同样保持不变。

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

格式：NDJSON 文件。

## 5. 必须记录的内容

### 始终记录

- 应用启动和关闭；
- host/agent 生成、握手和意外退出；
- 会话 create/delete；
- 提示 accepted/aborted；
- 工具 start/end 以及权限 request/decision/timeout；
- Plan 工件创建、approval、expiry、拒绝、执行转换和启动中断；
- shell 身份、超时、中止和进程树关闭；
- 插件 enable/disable/load/error；
- 工具准入拒绝、队列或资源耗尽，以及更新器错误。

这些记录在可用时应包含对应的会话、回合、工具调用、插件或稳定错误码。
正常成功操作不应输出逐阶段或逐请求的延迟记录。

### 绝不记录

- API 密钥或原始秘密；
- 完整的安全存储有效负载；
- 审计记录中不必要的大型读取完整文件内容。

## 6. 脱敏规则

1. 与 `/token|secret|password|api[_-]?key/i` 匹配的键名做脱敏处理。
2. Authorization 标头做脱敏处理。
3. 工具参数预览必须有界（例如 2KB）。
4. 审计记录中的长命令输出应计数或截断；stdout/stderr 数据块不得整体写入
   常规通道。

## 7. 追踪关联

尽可能为每个用户可见的操作使用一个 `traceId`：

- 提示 → `turnId`；
- 工具调用 → `toolCallId`；
- 权限流 → `toolCallId` / `requestId`。

Renderer、Electron、host 和 agent 应传播这些标识符。

## 7a. 功能性时长元数据

应用仍会保留产品功能所需的有界时长元数据：
`ToolsExecuteResult.duration_ms`、成绩单中的 `toolDurationMs` 和
`responseDurationMs`、委托任务的开始/完成时间戳，以及有界的 provider
诊断信息。这些值用于成绩单、上下文检查器、吞吐量展示和审计记录；
它们不会创建 timing 日志行。

host-core 的 audit 行可以保留既有的权限和执行时长字段用于取证检查。
它们是结构化审计数据，不是独立的 `timing.log` 流。

## 8. 面向用户的诊断

MVP 提供：

1. 带稳定代码的应用内错误文本；
2. “打开日志文件夹”命令；
3. 可选复制错误详细信息（代码和 `traceId`）。

MVP 不包含远程遥测管道或云崩溃分析。

## 9. 保留

- app/host/agent 类别日志：每个类别文件达到 5 MB 后轮换，并在旁边保留两个
  轮换文件（`<category>.1.log`、`<category>.2.log`）；
- audit 日志（SQLite）：与数据库一起保留，并按 host 保留策略清理；
- 轮换和日志写入失败绝不能让调用者失败。

会话成绩单属于用户数据，不会因日志轮换而删除。

## 10. 验收

1. 失败的工具调用可以通过 `toolCallId` 跨关键日志追踪。
2. 正常流程中秘密永远不会出现在日志文件中。
3. 可从应用或命令面板打开日志文件夹。
4. boot、host、sidecar、plugin、updater 和 renderer 路径只输出生命周期、
   状态变更、错误或安全相关记录；正常运行不会创建 timing 类别文件。
5. 当 stdout 是断开的管道时，日志或控制台镜像绝不能让主进程崩溃。
6. 主机重启、权限失败、shell 超时和进程中止仍可通过稳定的生命周期记录和
   错误码诊断。
