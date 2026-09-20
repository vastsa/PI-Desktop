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


表中的 `~/.pi-desktop` 路径属于正式打包版。开发构建把同一棵目录树写在
`~/.pi-desktop-dev` 下，`PI_DESKTOP_DATA_DIR` 会整体替换任一默认根目录（D599）。
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
- `tool` — 工具执行结果和中断
- `permission` — 权限请求和决定
- `plugin` — 插件加载、服务和插件工具执行
- `provider` — provider/model 发现、重试和缓存失败
- `persistence` — 成绩单和发件箱持久化失败
- `updater` — 更新器诊断和错误
- `diagnostics` — 阻止导航、菜单、模板以及对外请求的诊断。技能市场的两个通道会为每个没有产出结果的源或文档各记录一条 `skillMarket.sourceFailed` / `skillMarket.documentFailed`：`data` 里带 `source`、`host`、`kind`、`address`,以及被守卫拒绝时的 `reason`、`addressKind` 与 `route`。`kind` 在守卫判定的是目标自身地址时为 `policy`,判定的是本地代理伪造的 fake-IP 占位地址时为 `fake-ip`,本地解析没有返回答案时为 `unresolved`,其余为 `network`；`code` 前两者为 `NETWORK_POLICY_BLOCKED`,第三者为 `NETWORK_RESOLVE_FAILED`,因此一行日志即可区分「目标地址不是公网」「代理用了 fake-IP」与「解析器没有应答」。`reason` 记录守卫自己的分支（`url-syntax`、`resolve-failed`、`non-public-address`、`redirect-limit`）,`addressKind` 记录被拒地址的类别（TUN fake-IP 为 `benchmark`,RFC1918 为 `private`）,`route` 记录该地址是在哪条线路上被判定的（`proxied`、`direct`,或传输层读不出线路时的 `unknown`）,因此「直连线路上的 fake-IP 拒绝」与「读不出线路的拒绝」可以区分（ADR 0272）。记录会保留主机名、被解析到的地址、该地址的类别与该线路 —— 但绝不包含 URL、其路径、查询串或凭据 —— 因为目录源 URL 由用户提供,而被拒绝的主机、地址及其类别正是全部诊断价值所在（issue #419）。Chromium 进程崩溃后，下一次启动会写一条 `crashDumpsFound` 记录（任一新转储属于 browser/main 进程则为 `error`，否则为 `warn`），`data` 带 `count`、`total`、`byProcessType`、`directory` 与 `newestMtimeMs`。已恢复的 renderer 崩溃因此不会被写成「上次运行已死」。扫描失败是一条 `crashDumpReportFailed` 警告，永不挡住第一扇窗口（D602）。

- `runtime` — host/sidecar 生命周期、未分类的子进程输出，以及主进程
  `uncaughtException` / `unhandledRejection` 记录

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
  event: string              // 稳定的点号分隔机器可读名称
  message: string
  traceId?: string
  requestId?: string
  sessionId?: string
  turnId?: string
  toolCallId?: string
  parentToolCallId?: string
  agentName?: string
  pluginId?: string
  executionId?: string
  code?: string
  data?: unknown
}
```

格式：NDJSON 文件。

`event` 是稳定的查询键，`message` 是简短的人类可读摘要。关联字段位于
顶层，因此无需解析自由文本即可串联工具失败、权限请求和父子 agent。
`data` 仅用于诊断元数据，不是成绩单或命令输出；它会脱敏、限制深度和集合
大小，并且每条记录最多 8 KiB。

## 5. 必须记录的内容

### 始终记录

- 应用启动和关闭；
- host/agent 生成、握手和意外退出；
- 会话 create/delete；
- 提示 accepted/aborted；
- 工具完成/失败/中断以及权限 request/decision/timeout；
- Plan 工件创建、approval、expiry、拒绝、执行转换和启动中断；
- shell 身份、超时、中止和进程树关闭；
- 插件 enable/disable/load/error；
- 工具准入拒绝、队列或资源耗尽，以及更新器错误。

这些记录在可用时应包含对应的会话、回合、工具调用、插件或稳定错误码。
正常工具调用在 `tool_end` 后只产生一条完成或失败记录；sidecar 意外退出时，
为每个仍在运行的工具产生一条中断记录。sidecar 的 `tool_start`/`tool_end`
协议事件和成绩单持久化保持不变。正常成功操作不应输出逐阶段或逐请求的延迟记录。

### 绝不记录

- API 密钥或原始秘密；
- 完整的安全存储有效负载；
- 审计记录中不必要的大型读取完整文件内容。

## 6. 脱敏规则

1. 与 token、secret、password、API key、authorization、cookie、credential、
   private key 或 client secret 匹配的键名做脱敏处理。
2. 字符串中的 Bearer/Basic 凭据、URL 用户信息和常见 provider token 格式也做
   脱敏处理。
3. home、应用数据和日志目录前缀替换为占位符；诊断记录不保留原始本机路径。
4. 任意字符串有长度上限；结构化数据限制深度和集合大小，每条记录的 `data`
   最多 8 KiB；host-core 审计 payload 整形后也最多 8 KiB。
5. 工具参数和结果不会整体复制到常规日志。工具结果只保留结果、错误码、时长、
   字段名、内容块数量以及 stdout/stderr 大小等安全元数据；审计记录中的长命令
   输出应计数或截断。
6. 子进程 stderr 以稳定的 `child.process.stderr` 事件写入有界、去 ANSI 的
   `data.output`，而不是放入记录消息。

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
- `<data_dir>/crash-dumps` 中的 Crashpad minidump 不会被 logger 轮换，直到
  用户删除为止；
- 轮换和日志写入失败绝不能让调用者失败。


会话成绩单属于用户数据，不会因日志轮换而删除。

## 10. 验收

1. 失败和中断的工具调用可以通过 `toolCallId` 跨关键日志追踪，正常执行每次只
   有一条结果记录。
2. 正常流程中秘密永远不会出现在日志文件中。
3. 可从应用或命令面板打开日志文件夹。
4. boot、host、sidecar、plugin、updater 和 renderer 路径只输出生命周期、
   状态变更、错误或安全相关记录；正常运行不会创建 timing 类别文件。
5. 当 stdout 是断开的管道时，日志或控制台镜像绝不能让主进程崩溃。
6. 主机重启、权限失败、shell 超时和进程中止仍可通过稳定的生命周期记录和
   错误码诊断。
