# 06. 主机 RPC 协议

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/06-host-rpc-protocol) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. Goal

定义以下之间的本地协议：

- Electron 主要（协调器）
- Rust host-core（特权后端）
- Node pi 代理 sidecar（通过主机的工具请求者/事件源使用者）

MVP 传输决策 (**D001**)：

> **stdio JSON-RPC 优于 NDJSON**

## 2. 交通

- 流程：Electron 主要生成 Rust host-core sidecar
- 通道：子进程 stdin/stdout
- 成帧：每行一个 JSON 对象 (NDJSON)
- 编码：UTF-8
- Request/response：JSON-RPC 2.0 风格

控制管道在 host-core 内部是资源隔离的。一个专用操作系统
线程读取 stdin，并且一个专用操作系统线程序列化 stdout；请求和
工具任务从不执行 Tokio stdio 操作。这会保留临时操作系统
将管道 read/write 转换为 Tokio 阻塞池导致线程耗尽
恐慌。线程重试中断和瞬态非阻塞错误
保留每行一条消息的框架；不可恢复的管道错误结束
主机并由正常的 Electron 监控路径处理。

### 2. 1 运行时准入和背压

Host-core 不会为每个请求创建无限的任务或子进程。
RPC 调度程序将活动请求上限限制为 32。然后，`tools.execute` 输入
有界执行预算：

- 总共 16 次工具执行
- 全局 4 个并发 `Bash` 进程，每个会话 2 个
- 全球 8 个 read/search 工具
- 2 个全局变异工具，每个会话 1 个
- 全球4个插件工具
- 每个会话执行 4 次工具
- 全局 64 个排队工具执行

权限提示不占用执行槽。满队列返回
`HOST_OVERLOADED` 在工具结果中具有可重试语义，而不是
无限期地等待或产生更多工作。限制是主机拥有的，所以
Electron 和 sidecar 不能独立过度接纳相同的资源。
每会话突变许可是在全局突变槽之前获取的；
因此，排队的 `Bash`/read/search 调用在等待时不会保留全局容量
对于同一会话中的较早突变。

### 请求

```json
{
  "jsonrpc": "2.0",
  "id": "req_01H...",
  "method": "tools.execute",
  "params": {}
}
```

### 回应

```json
{
  "jsonrpc": "2.0",
  "id": "req_01H...",
  "result": {}
}
```

### 错误

```json
{
  "jsonrpc": "2.0",
  "id": "req_01H...",
  "error": {
    "code": 1003,
    "message": "PATH_OUTSIDE_WORKSPACE",
    "data": {
      "errorCode": "PATH_OUTSIDE_WORKSPACE",
      "details": {}
    }
  }
}
```

### 通知（服务器 → 客户端，无 id）

```json
{
  "jsonrpc": "2.0",
  "method": "permissions.request",
  "params": {}
}
```

## 3. 握手

在生成时，Electron 必须调用：

### `app.handshake`

参数：

```ts
type HandshakeParams = {
  protocolVersion: 9
  client: "electron-main"
  clientVersion: string
  locale: string // default "en"
}
```

结果：

```ts
type HandshakeResult = {
  protocolVersion: 9
  host: "rust-host-core"
  hostVersion: string
  features: string[]
}
```

规则：

1. 如果协议主要版本不匹配→中止启动
2. 如果握手失败，Electron 应退出并出现可操作错误
3.后续所有调用都需要握手成功
4. 版本4引入了持久通知收件箱和
   带有通知的 `session.endTurn` 结果。
5.版本5需要主机拥有的`session.fork`快照操作；一个
   在聊天变为交互式之前，必须拒绝版本 4 主机 (ADR 0023)。
6. 版本 6 添加了持久模型上下文检查点
   `session.appendCompaction`；版本 5 主机必须先被拒绝
   运行时声明自动上下文保护 (ADR 0030)。
7. 版本 9 是冻结的 ADR 0053/0054 合约：它涵盖了检查点
   Plan artifact/queue，主动转向 Plan identity/CAS，明确批准
   权限、shell 目录身份和方言 pin、流式命令输出、
   以及来自 `config_json` 的计划任务模式投影。 v7 或不兼容
   在 UI 变为交互式之前，必须拒绝 v8 主机。

协议 v9 仍然与 host-core 存储架构 v11 配对（v11 添加了
`plan_approvals.kind` 鉴别器）。架构版本
是一个内部持久性不变量，而不是附加的 JSON-RPC 字段；的
检查点架构仍然由主机拥有。

## 4. 方法目录(MVP)

### 应用程序
- `app.handshake`
- `app.health`
- `app.getVersion`

`app.health` 返回诊断 `toolBudget` 对象：

```ts
type ToolBudgetHealth = {
  active: number
  queued: number
  total: number
  shell: number
  reads: number
  mutations: number
  plugins: number
}
```

### 工作区
- `workspace.get`
- `workspace.set`
- `workspace.clear`

### 查看快照 (ADR 0043)
- `review.rollback({sessionId, snapshotId})` — 验证当前的后期工具
  hash，恢复会话拥有的先前字节，并返回其中之一
  `rolledBack`、`alreadyRolledBack`、`conflict` 或 `unavailable`。

### 项目
- `projects.list` — 返回先固定的持久项目记录，然后返回
  按上次开放时间；包括通过会话导入具体化的记录

### 秘密
- `secrets.set`
- `secrets.delete`
- `secrets.has`
- `secrets.getForRuntime` —— 仅 main/host 可用，渲染器永远够不到
- // 永远不会将 `secrets.get` 写入渲染器日志

一个提供商行有两个相互独立的引用 —— `secret:provider:<id>:api_key` 与
`secret:provider:<id>:oauth`（D237）。上面的通用方法同时服务于两者，因此
厂商账户凭据不需要新的主机方法。`ProviderPublic` 因此报告 `hasSecret`
（**任一种**凭据存在即为真）、`hasOauth` 与非敏感的 `oauthAccountLabel`；
`providers.create` / `providers.update` 接受 `oauthAccountLabel`，
`providers.delete` 清除两个引用。登录编排与令牌刷新留在 Electron 主进程，
永远不会进入本协议 —— 参见
[14-secrets-storage](/zh-CN/spec/03-runtime/14-secrets-storage) §10。

### 设置
- `settings.get`
- `settings.set`

### 会议
- `session.list`
- `session.create` — 接受可选的 `thinkingLevel`； missing/null 默认值
至 `off`
- `session.fork` — 接受 `sessionId`，呼叫者提供的可选显示
  `title`，以及可选的 `throughMessageId`；创造
  来自源当前活动规范的一个独立会话
  转录本，在提供时在选定的消息处被截断。
  孩子继承 project/provider/model/mode/thinking 并且
  权限配置，接收新的 message/tool-call id，并启动
  无需轮流、修订、通知、工件、资助或临时数据。
  缺少源返回 `NOT_FOUND`； Electron 拒绝活动源
  `AGENT_BUSY` 在转发之前并标准化主机的持久化
  运行转向 `CONFLICT` 回退到 `AGENT_BUSY`；来源不明或
  `throughMessageId` 返回 `NOT_FOUND`
- `session.get`
- `session.delete`
- `session.rename`
- `session.configure` — 以原子方式持久保存 `mode`、`providerId`、`modelId`，
  以及可选的 `thinkingLevel` 用于下一个 pi 回合； omitting/null
  `thinkingLevel` 保留当前值；返回无效模式或级别
  `INVALID_PARAMS`；模式为 `plan | goal | agent` 并更改任何会话
  仅在空闲且没有 pending/queued/running 时才允许配置
  Plan 或 Goal 记录
- `session.appendMessage`
- `session.saveInflightMessage` — 仅供 Electron 主进程使用的检查点，保存正在流式
  输出的助手回复：`{ sessionId, turnId?, message }` 原子替换
  `sessions/<id>.inflight.json`（D299，规格 04 §2.1）。返回 `{ ok, saved }`；
  消息没有可见文本、或该 id 已被索引（最终行先落盘）时 `saved` 为 false，后一种
  情况下还会移除残留检查点。非助手角色属于 `INVALID_PARAMS` 类失败
- `session.appendCompaction` — 仅附加最新类型的 sidecar
  模型上下文检查点。它需要非空 checkpoint/summary/boundary
ids 和非负 `tokensBefore`；它不会插入 message/search 行
  或更改可见的转录本投影
- `session.replaceMessages` — 原子记录重写（临时文件重命名 +
  regenerate/edit 流使用的一项索引交易（D119）且未得到答复
  渲染器智能停止撤消；它保留了
  仅当其边界和可选的第一个保留的 id 时才是最新的检查点
  在重写的前缀中仍然有效，并且它携带每个幸存消息的
  拥有 `turn_id` 跨越重写。只有拥有以下权限的调用者才安全
  通话期间的整个记录：快照的任何重写
  在 RPC 锁之外采取的可以删除附加在其间的消息
- `session.saveRevision` — 将重新生成分支归档到
  `(sessionId, rootUserId)`。带 `revisionIndex` 时，就地刷新该已有变体的
  载荷（分支自归档后又生长了），而不是新建索引；DB 行保留身份和活动
  标志，只更新 `message_count`
- `session.saveActiveRevision` — 归档最新的分支
  将带有修订版的用户 root 作为其活动修订版并标记该 root 的寻呼机
  元数据，全部位于 RPC 锁下。邮票重写了一行文字记录
  而不是文件，因此并发的 `session.appendMessage` 仍然存在。
  当会话不拥有重新生成历史记录时，返回 `{ saved: null }`。
  已归档的活动变体会被刷新，而不是跳过。
  回合完成调用者使用它而不是
  `session.get` + `session.replaceMessages`
- `session.listRevisions` — 列出根用户系列的线性变体
- `session.activateRevision` — 用 `prefix + branch` 替换实时转录
  并标记根寻呼机元数据。切换前它先从持久转录本重新归档该系列的实时
  分支（刷新实时根消息 `activeRevision` 标记所指的变体，或把已标记但从未
  归档的分支存为新变体），因此上次归档之后追加的内容不会丢失。当该系列
  存在于持久转录本中时，恢复分支之前的前缀取自转录本而非调用方。幸存
  消息保留所属的 `turn_id`
- `session.beginTurn`
- `session.endTurn` — 以原子方式将正在运行的回合移动到其终止状态，并且
有条件地返回新创建的 `completed`/`error` 通知；它还会落定该会话的进行中回复
  检查点（D299）：`completed`/`error` 移除它；`recoverInflight: true`（sidecar
  已丢失、不会再有最终行时发送）把最终行从未落盘的检查点提升为 `aborted` 助手消息
  写入转录并作为 `recovered` 返回；普通的 `aborted`（用户停止）保留检查点，交给
  即将到达的最终行取代；
  当 `createNotification=false`、`aborted` 或
  对于已经结束的回合
- `session.import` — 以原子方式导入一个转换后的会话；一个非空的
  项目路径在会话之前进行规范化并更新插入到 `projects` 中
  引用它；返回 `{ imported, skipped }`

### Plan 和 Goal 状态和批准

两种合约类型共享这些方法；可选的 `kind`
（`plan | goal`，默认 `plan`，因此 D198 之前的 sidecar 仍然有效）选择哪个
合同正在洽谈中。

- `plans.enter` — 仅接受活动 Agent 回合的 `sessionId`、`turnId`，
  和 `toolCallId` 加上 `kind`； host-core 执行模式转换至
  具有比较和交换更新的那种模式并发出 `plans.changed`
  携带 `kind`。无法识别的 `kind` 失败并显示 `INVALID_PARAMS`
- `plans.submit` — 将主机拥有的工件写入该种类的目录下，并
  创建一个待处理的提案，其 `kind` 保留在该行上
- `plans.pending` — 仅返回待批准行、会话计划
  状态，以及正在协商的合约的 `kind`（待处理行的类型，
  回到会话自己的合约模式）；渲染器重新加载不会
  在主机还活着并且不恢复的情况下延长绝对期限
  终端卡
- `plans.resolve` — 验证一个匹配的 approve/reject 响应，并且
  批准，提交所选权限模式和 `execution_state = queued`
- `plans.queuedExecutions` / `plans.claimExecution` /
`plans.finishExecution` — 消耗并转换执行字段
  同一审批行；声明的执行报告其 `kind`，因此 sidecar 可以
  选择匹配的执行指令
- `plans.abort` — 标记待审批工作已中断；它永远不会重播或
  将已批准的会话更改回其合同模式

### 计划任务

- `scheduled.list` / `scheduled.create` / `scheduled.update` /
  `scheduled.delete`
- `scheduled.import` — 导入任务记录并标准化其持久模式
- `scheduled.run` / `scheduled.finishRun` / `scheduled.listRuns`

线 `ScheduledTask.mode` 是耐用的标准化投影
`config_json.mode`；创建、更新和导入映射旧版 `chat` 到 `plan` 以及
默认缺失值为 `agent`。 `scheduled.run` 读取所选任务的
持久模式； `plan` 或 `goal` 任务失败并显示
创建会话或运行之前的 `PLAN_REQUIRES_INTERACTIVE_SESSION`。它从来没有
使用 `settings.defaultMode` 作为任务模式。

宿主边界的规范思维水平是：

```text
off | minimal | low | medium | high | xhigh | max
```

会话 summaries/details 始终返回 `thinkingLevel`。助理消息
可能会返回 `thinking`；主机存储将其映射到规范内容块，而不是
而不是将其附加到答案 `content` 中。

### 工具
- `tools.list`
- `tools.execute`
- `tools.abort`
- 有序 `stdout`/`stderr` 块的 `tools.output` 通知

### 贝壳
- `commandShells.list`
- `settings.set` 带有部分设置对象；保留省略的字段，
  并且仅当每个
  会话没有活动轮次并且没有 pending/queued/running Plan/Goal 工作

工具执行仅在准入后开始。 Shell 生成重试瞬态
资源耗尽（`EAGAIN` / `WouldBlock`），具有有限的退避，从不
在命令启动后重试命令，并在之前获取超时的子命令
释放执行槽。

`session.appendMessage` 通过消息 ID 是幂等的。 Electron 主要可以保留
当 host-core 重新启动时，消息会附加到其应用程序拥有的发件箱中；
握手成功后，发件箱会按顺序冲洗。进行中检查点从不经过发件箱：检查点只对存活的
主机有意义，在最终行之后重放它是错误的。

### 权限
- `permissions.evaluate`
- `permissions.resolve`
- `permissions.listSessionGrants`
- `permissions.clearSessionGrants`

### 插件
- `plugins.list`
- `plugins.loadDev`
- `plugins.installFromPath`
- `plugins.enable`
- `plugins.disable`
- `plugins.uninstall`
- `plugins.getPermissions`

### 审计
- `audit.append`
- `audit.query`（稍后可选）

### 通知 (D117)
- `notification.list`
- `notification.markRead`
- `notification.markAllRead`
- `notification.clear`

## 4a。通知合约（协议 v4）

```ts
type AppNotification = {
  id: string;
  kind: "task.completed" | "task.failed";
  sessionId: string;
  sessionTitle: string;
  turnId: string;
  errorCode?: string;
  createdAt: string; // ISO-8601 UTC
  readAt?: string | null;
};

type SessionEndTurnParams = {
  turnId: string;
  status: "completed" | "error" | "aborted";
  errorCode?: string;
  usage?: unknown;
  createNotification?: boolean; // default true; Electron supplies visibility decision
};

type SessionEndTurnResult = {
  ok: boolean; // false when the turn was missing/already terminal
  notification?: AppNotification; // omitted when no row was inserted
};

type NotificationListParams = {
  unreadOnly?: boolean; // default false
  limit?: number;       // default/max 200
};

type NotificationListResult = {
  notifications: AppNotification[]; // newest first
  unreadCount: number;               // global count, independent of filter
};
```

- `notification.markRead({ id }) -> { ok }` 是幂等的。 `ok=false` 意味着
  该id不存在；已读取的行仍然成功。
- `notification.markAllRead({}) -> { ok: true }` 更新中的每个未读行
  一笔交易。
- `notification.clear({}) -> { ok: true }` 仅删除收件箱行。
- 不发出 `notification.created` JSON-RPC 服务器通知。 Electron
  直接从 `session.endTurn` 接收插入的记录，避免了
  终端转持久化和UI刷新之间的第二个点餐通道。
- `createNotification=false` 仅抑制收件箱插入；跑步回合
  仍然在同一事务中达到其请求的最终状态。失踪
  或非布尔值默认为 true，因此 unknown/stale UI 状态不会丢失
  通知。
- `sessionTitle` 是与行一起存储的稳定会话名称快照。
本地化事件 title/body 散文是由 Electron/renderer 衍生而来，从未
  跨越主机 RPC。

## 5. 工具执行合约

### `tools.execute` 参数

```ts
type ToolsExecuteParams = {
  sessionId: string
  turnId?: string
  toolCallId: string
  toolName: string
  args: unknown
  /** Diagnostic/request context only; never used for authorization. */
  requestedMode?: "plan" | "goal" | "agent"
  expectedCommandShellId?: CommandShellId
  /** Bash only: dialect pinned by the same runtime turn. */
  expectedCommandShellDialect?: "powershell" | "cmd" | "posix"
  /** Bash only: host default 60000; accepted override 1000..300000. */
  timeoutMs?: number
}
```

权威模式和工作区解析是会话范围的：

1. 主机加载 `sessionId` 并解析其持久保存的 Electron/renderer/path。
2. 主机读取持久保存的 `sessions.mode` 并将其验证为 `plan | agent`。
   冲突的 `requestedMode` 会被忽略以进行授权并仅记录
   作为诊断数据。
3、该路径成为工具沙箱根目录，用于权限预览、执行、
   工件路径和审核上下文。工具的显式 `path` 可能会命名
   仅在主机应用外部路径权限后才位于外部位置
   规则；成功的外部结果保留了绝对的规范路径。
4. 不会参考可变的 `workspace.get` 选择来获取有效的持久性
   会话，因此切换保留的项目选项卡无法重定向背景
   打电话。
5.持久无路径会话解析无根并接收
   `WORKSPACE_REQUIRED` 工具需要一个。选定的项目不是
   继承的。
6. 会话不存在的旧调用可能会暂时回退到会话
   选定的工作空间；新的渲染器流必须始终提供有效的
   `sessionId`。
7、database/session-resolution错误返回`INTERNAL`，关闭失败；
   只有已确认的丢失会话才可以使用旧后备。

对于`Read`/`Glob`/`Grep`/`Write`/`Edit`，主机分类显式路径
在工作区之外并在低风险自动允许规则之前从头开始。
`auto` 执行它，而 `ask` 和 `accept-edits` 发出
`permissions.request`；拒绝、超时或取消返回 `TOOL_DENIED`
而不执行该操作。相对 `..` 和符号链接转义使用
相同的分类。 Bash 的工作目录和隐式递归遍历
不继承这个异常。

在通用权限评估之前，host-core 应用模式策略：

- Plan 和 Goal 允许 `Read`、`Glob`、`Grep`、`BrowserPreview`、`Bash` 和
  适用于实时的种类提交工具（`SubmitPlan` / `SubmitGoal`）
  规划状态。
- Plan 和 Goal 拒绝 `Write`、`Edit`、每个插件工具以及以下未知工具
  所有权限模式和授予。主机读取会话的**持久**模式
  对于此检查，因此在 `tools.execute` 中声明 `agent` 的 sidecar 无法扩大
  它和 `*_IN_PLAN` 错误代码是两种类型共享的。
- Plan 和 Goal `Bash` 遵循已解析的权限模式：`ask` 和
  `accept-edits`
  发出 `permissions.request`； `auto` 无需确认即可执行，并且可能
  变异。主机重新解析有效 shell ID/dialect 并要求
  精确之前的 `expectedCommandShellId` 和 `expectedCommandShellDialect`
  权限评估并在生成前再次评估；它流式传输 stdout/stderr
  分别。配置好的 shell 可能会回退到第一个可用平台
  创建转销之前的 shell，但执行不会改变 shell
  在引脚之后。
- Agent 应用正常的注册工具和权限策略。

可见的工具列表不是安全边界；伪造的 RPC 调用是
由该主机端矩阵授权。

### 结果

```ts
type ToolsExecuteResult = {
  toolCallId: string
  ok: boolean
  isError?: boolean
  content: unknown
  durationMs: number
  denied?: boolean
  errorCode?: string
  // Workspace Write/Edit results may include content.details.review. The
  // record is persisted with the tool message and is independent of Git.
  // Bash command failures preserve content.exitCode/stdout/stderr while
  // setting ok=false, isError=true, and errorCode=TOOL_FAILED.
  // The agent runtime forwards isError into the tool transcript without
  // dropping the structured content/details needed for recovery.
}
```

### 5. 1 Plan 和 Goal 提交和批准合约

`SubmitPlan` 和 `SubmitGoal` 在通用之前作为主机转换进行处理
工具执行。主机将准确的 Markdown 字节保留在新的唯一的
在发布提案之前，先将工件放在种类的目录下。

```ts
// Identical shape for both kinds; the tool name selects the kind.
type SubmitPlanParams = {
  title: string;
  markdown: string;
  question: string;
};

type ProposalKind = "plan" | "goal";

type PlanningState = "inactive" | "planning" | "awaiting_approval";

type GlobalPermissionMode = "ask" | "accept-edits" | "auto";

type PlanApprovalAction = "approve" | "reject";

type PlanProposalStatus =
  | "pending" | "approved" | "rejected"
  | "expired" | "interrupted";

type PlanExecutionState =
  | "queued" | "running" | "completed" | "interrupted";

type PlanArtifact = {
  relativePath: string; // `.pi/plan/<unique-name>.md` or `.pi/goal/<unique-name>.md`
  sha256: string;
  sizeBytes: number;
};

type PlanProposal = {
  id: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  // Which contract this approval carries; rows written before the
  // discriminator existed read back as `plan`.
  kind: ProposalKind;
  plan: string;
  markdown: string;
  title: string;
  question: string;
  status: PlanProposalStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  action?: PlanApprovalAction;
  targetPermissionMode?: GlobalPermissionMode;
  errorCode?: string;
  artifact?: PlanArtifact;
  version: number;
  executionId?: string;
  executionState?: PlanExecutionState;
};

type PlanExecution = {
  id: string;
  proposalId: string;
  sessionId: string;
  // Which contract was approved; selects the sidecar's execution instruction.
  kind: ProposalKind;
  plan: string;
  title: string;
  question: string;
  artifact: PlanArtifact;
  targetPermissionMode: GlobalPermissionMode;
  state: PlanExecutionState;
};

type PlansPendingResult = {
  plans: PlanProposal[];
  state?: PlanningState;
  // The contract being negotiated: the pending row's kind, else the session's
  // own contract mode. Absent when nothing is being negotiated.
  kind?: ProposalKind;
};

type PlanResolveIdentity = {
  proposalId: string;
  sessionId: string;
  turnId: string;
  toolCallId: string;
  version?: number;
};

type PlanResolveRequest =
  | (PlanResolveIdentity & {
      action: "approve";
      targetPermissionMode: GlobalPermissionMode;
    })
  | (PlanResolveIdentity & { action: "reject" });

type PlanResolutionResult = {
  ok: boolean;
  proposal: PlanProposal;
  state: PlanningState;
  action?: PlanApprovalAction;
  targetPermissionMode?: GlobalPermissionMode;
  execution?: PlanExecution;
};
```

主持人通知：

```text
method: "plans.changed"
params: {
  sessionId: string
  state: PlanningState
  kind?: ProposalKind
  proposalId?: string
  proposal?: PlanProposal
  action?: PlanApprovalAction
  targetPermissionMode?: GlobalPermissionMode | null
  execution?: PlanExecution | null
}

type ToolsOutputParams = {
  sessionId: string
  toolCallId: string
  commandShellId: CommandShellId
  stream: CommandShellOutputStream
  chunk: string
}

method: "tools.output"
params: ToolsOutputParams
```

`plans.changed` 是针对 Plan 或 Goal 条目、提交、解决而发出的，
执行 claim/finish，然后中止。它的顶级参数正是字段
显示；不适用于转换的字段被省略，并且 `kind` 命名
合同，以便渲染器可以选择正确的模式芯片和批准副本，而无需
检查投影状态。对于 `plans.resolve`，
当没有值时，主机发出 `targetPermissionMode` 和 `execution` 作为 JSON `null`
存在。 Electron 通过以下方式转发此通知：
共享 `IPC.event.plansChanged` 渲染器通道。

`plans.resolve` 仅接受经过身份验证、仍待处理的请求，其
提案、会话、轮次、工具调用和版本匹配。 `approve` 需要
显式权限模式并原子地将 `plan_approvals` 行提交到
`status = approved`，分配 `execution_id`，设置 `execution_state = queued`，
设置 `sessions.mode = agent`，并存储所选的
`sessions.permission_mode`；该选择未写入应用程序设置中
作为下一次默认批准。询问仍然是产品默认设置。然后，同一个 Agent 会收到一个新的提供商
使用 Agent 工具请求。

`reject` 记录 `rejected` 并使会话处于合同模式（Plan 或
Goal）。绝对的
30 分钟截止时间记录 `expired` 和 `PLAN_APPROVAL_TIMEOUT`。中止，主机
重新启动、sidecar 重新启动或持久性失败记录 `interrupted`。之前
启动后提供 RPC 服务，主机以事务方式中断之前的挂起
批准和 queued/running 执行状态。待处理、排队和运行
工作永远不会重播； queued/running 批准后中断离开
Agent 中的会话。进程纪元是内部的，不是线路或数据库
场。

### 5. 2 Shell 目录

```ts
type CommandShellId = "windows-powershell" | "cmd" | "git-bash" | "bash";

type CommandShellOption = {
  id: CommandShellId;
  label: string;
  dialect: "powershell" | "cmd" | "posix";
  available: boolean;
  isDefault: boolean;
};

type CommandShellCatalog = {
  configuredId: CommandShellId | null;
  effective: CommandShellOption | null;
  fallback: boolean;
  choices: CommandShellOption[];
};

type CommandShellOutputStream = "stdout" | "stderr";
```

`commandShells.list` 返回主机发现结果。设置写入存储
仅使用目录 ID，并拒绝未知、不可用或错误的平台 ID
`COMMAND_SHELL_INVALID`。如果持久化 ID 稍后变得不可用，则
Catalog 选择第一个可用的平台 shell 并设置 `fallback: true`。
Bash 请求包含同一轮中固定的有效 ID 和方言；
host-core 拒绝之前使用 `COMMAND_SHELL_CHANGED` 更改的 ID 或方言
权限评估和生成前。身份不是可执行路径
哈希。

## 6. 权限请求通知

主机可能会发出：

```ts
method: "permissions.request"
params: {
  requestId: string
  sessionId: string
  toolCallId: string
  toolName: string
  risk: "low" | "medium" | "high"
  argsPreview: unknown
  reason: string
  timeoutMs: 120000
}
```

Electron/UI 通过以下方式解决：

```ts
method: "permissions.resolve"
params: {
  requestId: string
  decision: "allow-once" | "allow-session" | "deny"
}
```

超时行为 (**D005**)：120 秒后未解决 → 拒绝。

## 7. 错误代码

| 代码 | 错误代码 | 意义 |
|---|---|---|
| 1000 | 内部 | 意外主机故障 |
| 1001 | 未经授权 | missing/invalid 握手或功能 |
| 1002 | 无效参数 | 架构验证失败 |
| 1003 | PATH_OUTSIDE_WORKSPACE | 在明确的外部路径权限决策之前发生路径沙箱违规 |
| 1004 | TOOL_DENIED | 许可被拒绝 |
| 1005 | 工具超时 | 工具超出超时时间 |
| 1006 | WORKSPACE_REQUIRED | 无工作空间限制 |
| 1007 | 未找到 | 实体缺失 |
| 1008 | 冲突 | busy/conflict 状态 |
| 1009 | PLUGIN_INVALID | manifest/validation 失败 |
| 1010 | PLUGIN_LOAD_FAILED | enable/load 失败 |
| 1011 | 协议_不匹配 | 握手版本不匹配 |
| -32029 | HOST_OVERLOADED | RPC 调度程序容量已耗尽 |
| 1012 | WRITE_DISABLED_IN_PLAN | Plan 和 Goal 中无法写入 |
| 1013 | EDIT_DISABLED_IN_PLAN | 在 Plan 和 Goal 中无法进行编辑 |
| 1014 | PLUGIN_DISABLED_IN_PLAN | 插件工具在 Plan 和 Goal 中不可用 |
| 1015 | PLAN_APPROVAL_REQUIRED | SubmitPlan/SubmitGoal 正在等待批准 |
| 1016 | 计划批准超时 | 绝对批准期限已过 |
| 1017 | 计划批准_STALE | 响应与实时 proposal/session/turn/tool-call/version 不匹配 |
| 1018 | 计划批准中断 | 等待批准失败，在 abort/recovery 期间关闭 |
| 1019 | PLAN_REQUIRES_INTERACTIVE_SESSION | 无人值守的 Plan 或 Goal 无法运行 |
| 1020 | PLAN_ARTIFACT_WRITE_FAILED | 无法将确切的字节写入新的 `.pi/<kind>/*.md` 工件 |
| 1021 | 计划执行中断 | 批准的 queued/running Plan 或 Goal 执行被中断 |
| 1022 | SHELL_NOT_FOUND | 没有有效的平台 shell 可用 |
| 1023 | 命令_SHELL_CHANGED | 固定的 shell ID 或方言在执行前已更改 |

## 8. 并发/排序

1. 请求可以在调度程序上限内并发。 Read/search 工具可能
   并行运行；每个会话的 Read/search/`Write` 都是有界的并且按 FIFO 顺序排列，
   一次会话中最多有一个突变。
2. 不同的会话可以在保留的项目选项卡上同时继续；
   每个都解析自己的项目根并授予
3. 握手后随时可能收到通知
4. `tools.output` 保留 stdout/stderr 分离和通知顺序；
   它的作用域为 session/tool 调用，并且没有回合或排序字段；
   最终结果仍然有限
5. Abort是幂等的，关闭整个Bash进程树
6. Plan 和 Goal 批准请求为 proposal/session/turn/tool-call/version
   范围；
   每个项目仅存在一项待批准和一项 queued/running 执行
   会话，并且分辨率由 host-core 序列化
7. 启动事务性地中断待批准和 queued/running
   RPC 服务之前的执行状态。延迟渲染器响应无法关闭；
   挂起的中断保持会话的合同模式和
   已批准的 queued/running 中断保留 Agent。
8. 会话分叉是一种主机拥有的快照操作。源转录本
   永远不会被重写，并且处理的子 write/index 失败不会留下任何结果
   可见的会话或孤立的转录文件。 D119 之后发生进程崩溃
   现有的孤儿成绩单恢复政策。
9. 消息范围的分叉除了规范快照结束之外是相同的
包括在 `throughMessageId`。它仍然重新映射 message/tool-call id 和
   不创建运行时或修订状态，因此稍后的子 reseed/cache 状态为
   由新的会话 ID 隔离。

## 9. 日志记录规则

- 从不记录 API keys/secrets
- 工具参数可能会在审核预览中进行编辑
- 每个tools.execute都会获得trace id = `toolCallId`

## 10. 验收

1. Electron 生成主机并完成握手
2.health方法返回ok
3. 拒绝刀具路径返回 `TOOL_DENIED`
4.超时路径120s后返回拒绝决策
5.将选定的工作空间从A切换到B不会改变工具根
   会话 A 发出的呼叫的
6. 协议 v4 `session.endTurn` creates/returns 恰好有一个通知
   未见 completed/failed 轮次，并且没有可见电流、中止或
   重复终端更新
7.通知list/unread/read-all/clear通过host-core往返
   仍受最新 200 个持久行的限制
8. 分叉一个空闲会话会产生一个独立可变的子进程
   离开时具有相同的活动转录本和持久执行配置
   源及其重新生成的修订版保持不变
9. 分叉消息会排除后面的所有源行并拒绝
   未创建子项的未知消息
10. 伪造的 `requestedMode` 无法授权工具进入持久模式；
    Plan 和 Goal 拒绝 Write/Edit/plugin/unknown 工具并申请权限
    根据 `requestedMode`/Write/Edit/plugin/unknown/Plan 提示 Bash
11. SubmitPlan 和 SubmitGoal 将精确的 Markdown 字节写入唯一的
    `.pi/plan/*.md` 或 `.pi/goal/*.md` 文件
    hash/size 和结构化 title/question 字段；仅匹配
    approve/reject 响应可以解析实时 `plan_approvals` 行，并且
    针对其他类型运行的提交工具失败并显示 `PLAN_KIND_MISMATCH`
    无需编写工件
12. Plan 和 Goal 过期、中止、崩溃、计划拒绝和陈旧响应
    产生记录的持久状态和事件
13. Bash 验证固定 shell ID/dialect，传输 stdout/stderr，强制执行
    60s default/bounded 覆盖，并关闭整个进程树
