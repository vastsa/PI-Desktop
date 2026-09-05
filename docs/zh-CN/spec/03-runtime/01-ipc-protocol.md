# 01. IPC 协议

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/01-ipc-protocol) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 目标

定义渲染器和主程序之间的稳定契约。

原则：

1. 所有功能均经过 preload 许可名单
2. 输入 Requests/responses
3. 长时间运行的任务使用事件流，而不是单个超大响应
4. 错误必须有代码+消息

## 2. API 组

| 域名 | 描述 |
|---|---|
| `app` | 应用程序信息、健康检查 |
| `agent` | 对话、中止、状态和交互式 Asktool 解决方案 |
| `plan` | Plan 提案列出、决议和变更事件 |
| `session` | 会话 CRUD/历史记录 |
| `settings` | 配置 read/write |
| `secrets` | 秘密 write/delete/exists（绝不将明文返回到 UI 日志） |
| `project` | 工作空间选择与查询 |
| `tool` | 权限确认回调 |
| `shell` | 主机 shell 目录和持久默认 shell |
| `log` | 前端可以显示的诊断信息 |
| `plugin` | 插件 install/enable-disable/query/permissions |
| `commandPalette` | 命令面板搜索和执行 |
| `workspace` | 工作区选择和遗留工作树诊断 |
| `browser` | 工作面板嵌入预览 navigation/bounds/visibility + 状态事件 |
| `fs` | 工作面板工作区文件 listing/reading/reveal（只读） |
| `window` | 无框窗口状态、控件和有界工作面板宽度预留 |
| `menu` | 列入许可名单的应用程序菜单命令和本机 editing/window 操作 |
| `notification` | 持久收件箱 list/read/clear 和 new/activated 事件 |

## 3. 渠道约定

```text
invoke: pi-desktop/<domain>/<action>
event: pi-desktop/<domain>/event/<name>
```

示例：

- `pi-desktop/agent/prompt`
- `pi-desktop/agent/abort`
- `pi-desktop/agent/event/message`
- `pi-desktop/agent/askTool/resolve`
- `pi-desktop/session/list`
- `pi-desktop/project/open`
- `pi-desktop/project/openFolder`

## 4. 通用响应包络

```ts
type Result<T> =
 | { ok: true; data: T }
 | { ok: false; error: AppError };

type AppError = {
 code: string;
 message: string;
 details?: unknown;
 retriable?: boolean;
};
```

## 5. Agent API

### 5.1 提示

```ts
type AgentPromptRequest = {
 sessionId: string;
 content: string;
 /** Truncate durable transcript to N leading messages before append (regenerate). */
 truncateBefore?: number;
 /** Renderer snapshot used to close the prompt-to-completion notification race. */
 viewingSessionId?: string | null;
};

type AgentPromptResponse = {
 accepted: boolean;
 turnId: string;
};
```

斜线模板扩展 (D123)：当 `content` 以 `/name` 开头且
名称与加载的 pi 提示模板匹配，主进程处理程序展开
持久化之前调用 (`parseCommandArgs` + `substituteArgs`)。
持久化的用户消息存储 `content = expanded text` 以及一个可选的
`command: string` 字段携带转录的键入调用
显示。重新设定种子会重播 `content`，因此代理上下文在整个过程中是相同的
重新启动。 Builtin/plugin 斜杠别名永远不会到达此通道 —
渲染器在本地执行它们。未知的 `/foo` 作为文字传递
内容。 `@path` 令牌不会在管道 (D124) 中的任何位置进行转换。

提示执行解析 `mode`、`providerId`、`modelId` 和 `thinkingLevel`
从持久会话记录和快照中获取有效的命令 shell ID 和
Bash 的方言。
渲染器通过以下方式更改这些值
会话空闲时的 `pi-desktop/session/configure`：

```ts
type ThinkingLevel =
  | "off" | "minimal" | "low" | "medium"
  | "high" | "xhigh" | "max";

type SessionConfigureRequest = {
  id: string;
  mode: "plan" | "goal" | "agent";
  providerId?: string;
  modelId?: string;
  thinkingLevel: ThinkingLevel;
};
```

仅当会话空闲时才接受 `session/configure`。模式、提供商、
模型、权限和 shell 默认更改在回合或回合时被拒绝
Plan/Goal `content = expanded text`/`command: string`/`content` 记录存在。渲染器可能会保留这些
控制在回合期间可编辑，但它会将最新的完整配置排队
本地并仅在终止事件后调用此通道；跑步的
回合永远不会观察到乐观的下一个回合选择。

只有更改后的有效全局 `defaultCommandShell` 在所有范围内仅处于空闲状态
受影响的会话：任何活动轮次或 pending/queued/running Plan/Goal 工作块
该 shell 会发生变化，而省略的或幂等的 shell 字段则不会。

图像和文件有效负载不是当前提示合同的一部分。

重新生成历史记录 (D109) 也使用会话通道：

- `pi-desktop/session/saveRevision`
- `pi-desktop/session/listRevisions`
- `pi-desktop/session/activateRevision`

Root 用户轮次可能包括 `revisionRootId`、`revisionCount` 和
`activeRevision`。激活修订版将实时尾部替换为
`prefix + archived branch` 并处置会话代理。
 输入框
附件可供性保持隐藏，直到 main、sidecar、pi 模型
功能和持久性都会消耗有效负载。

### 5.2 在下一个回合边界停止

```ts
type AgentStopRequest = {
 sessionId: string;
 turnId?: string;
};

type AgentStopResponse = {
 requested: boolean;
};
```

`pi-desktop/agent/stop` 为活动运行时请求一次优雅停止。sidecar 在当前助手
响应和已完成的工具批次之后评估这个一次性请求，也就是它本来会发起下一次
模型请求的同一个边界。当前的持久回合随后发出 `agent_end` 并被终结为
`completed`；该请求不会中止提供商流、取消正在运行的工具，也不会开启第二个
并发回合。空闲会话返回 `requested: false`。

渲染器按会话持有可移除的、仅存于内存的排队提示词列表。它只在排队项的
**立即发送** 操作时调用该渠道，并在终止事件之后通过常规的 `agent/prompt`
流程释放该项。

### 5.3 中止

```ts
type AgentAbortRequest = {
 sessionId: string;
 turnId?: string;
};
```

中止请求和响应不携带 Composer 草稿或文件参考数据。
如果渲染器智能停止撤消未应答的用户回合，则恢复来自
渲染器的 session/turn-scoped 预序列化快照；现有的
转录重写会删除发送的行而不更改协议版本。该重写从完整持久转录（不带窗口的
`session.get`）与实时行的合并结果计算，绝不使用渲染器分页且显示截断的窗口，并在
该合并结果上重新判定：在中止与读取之间落盘的回复行会把撤销变成落定（D299）。
发现回复已开始的停止只在渲染器内存中落定（流式助手 → `aborted`，运行中工具 →
错误），不做任何转录重写；持久副本是运行时自己的中止最终行，若它始终未到，则是
主机提升的进行中检查点。

### 5.4 紧凑型（协议 v10）

```ts
type AgentCompactRequest = { sessionId: string };
type AgentCompactResponse = { accepted: boolean };
```

`pi-desktop/agent/compact` 为空闲创建模型上下文检查点
会议。即使自动上下文保护被禁用，它也可用。
缺少 provider/session 配置无法通过正常的 `AppError`
信封；主动转向或压实返回 `AGENT_BUSY`。

### 5.5 Plan 和 Goal 检查点批准

合同批准与工具许可是分开的。 Plan 和 Goal 分享此内容
整个表面； `kind` 是唯一的鉴别器 (**D198**)。渲染器接收
的
来自同一 Agent 的主机写入的工件元数据并通过以下方式解析它
输入 preload IPC；它永远不会乐观地改变会话模式。合同
条目
并且提交仍然是 Agent/host 操作，而不是渲染器 preload 方法。

```ts
type PlanningState = "inactive" | "planning" | "awaiting_approval";

type ProposalKind = "plan" | "goal";

type GlobalPermissionMode = "ask" | "accept-edits" | "auto";

type PlanApprovalAction = "approve" | "reject";

type PlanProposalStatus =
  | "pending" | "approved" | "rejected"
  | "expired" | "interrupted";

type PlanExecutionState =
  | "queued" | "running" | "completed" | "interrupted";

// Same shape for SubmitPlan and SubmitGoal; the tool name selects the kind.
type SubmitPlanInput = {
  title: string;
  markdown: string;
  question: string;
};

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
  // Legacy rows written before the discriminator existed read back as `plan`.
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
  kind: ProposalKind;
  plan: string;
  title: string;
  question: string;
  artifact: PlanArtifact;
  targetPermissionMode: GlobalPermissionMode;
  state: PlanExecutionState;
};

type PlanningStateEvent = {
  sessionId: string;
  state: PlanningState;
  // Absent only for `inactive` transitions that carry no proposal.
  kind?: ProposalKind;
  proposalId?: string;
  title?: string;
  markdown?: string;
  question?: string;
  artifact?: PlanArtifact;
  version?: number;
  plan?: string;
  action?: PlanApprovalAction;
  targetPermissionMode?: GlobalPermissionMode;
  executionId?: string;
  executionState?: PlanExecutionState;
  proposal?: PlanProposal;
};

type PlansPendingResult = {
  plans: PlanProposal[];
  state?: PlanningState;
  // The contract being negotiated, for mode chip and approval copy.
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

预加载方法：

- `pi-desktop/plans/pending({ sessionId? }) -> PlansPendingResult`
- `pi-desktop/plans/resolve(PlanResolveRequest) -> PlanResolutionResult`

Electron 将每个主机 `plans.changed` 通知原封不动地转发到
通过稳定的共享 `IPC.event.plansChanged` 通道渲染器
（`pi-desktop/plans/event/changed`）。这是 Plan/Goal 更改事件表面；
的
渲染器不会接收作为 AgentEvent 变体的合同批准转换。
`plans.pending` 仅返回当前待批准的行。终端
`plan_approvals` 行保留持久主机记录，但不是渲染器
水合数据；渲染器仅保留其最新的合同快照
当实时 `plans.changed` 事件到达时当前渲染器的生命周期。

对于 `approve`、host-core 和 Electron 需要显式
`targetPermissionMode`； Electron 永远不会从存储的设置中填充它。的
渲染器将每个批准初始化为“询问”，这仍然是产品默认值，
并且主持人不会将选择保留为下一次批准默认值。
`reject` 携带无权限模式。
对错误提案、会话、回合、工具调用、版本或过期的响应
主机拥有的截止日期失败，并出现稳定的 Plan/Goal 批准错误。没有
请求更改操作。

### 5.5 获取状态

```ts
type AgentStatus = {
 sessionId: string;
 isRunning: boolean;
 currentTurnId?: string;
 modelId?: string;
 pendingToolConfirmations: number;
};
```

## 6. Agent 活动

从主→渲染器推送：

```ts
type AgentEventEnvelope = {
 sessionId: string;
 turnId?: string;
 ts: number;
 event: AgentEvent;
 /** Set on events emitted inside a subagent (D201, ADR 0062): the `Task` call
  * that spawned it, and the definition name. */
 parentToolCallId?: string;
 agentName?: string;
};

type AgentEvent =
 | { type: "agent_start" }
 | { type: "agent_end"; messageIds: string[] }
 | { type: "turn_start" }
 | { type: "turn_end" }
 | { type: "message_start"; message: UiMessage }
 | { type: "message_update"; message: UiMessage;
     deltaText?: string; deltaThinking?: string }
 | { type: "message_end"; message: UiMessage }
 | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
 | { type: "tool_update"; toolCallId: string; partialResult?: unknown }
  | { type: "tool_end"; toolCallId: string; result: unknown; isError?: boolean;
      toolUsage?: ToolTokenUsage }
  | ({ type: "planning_state" } & Omit<PlanningStateEvent, "sessionId">)
  | { type: "tool_permission_request"; request: ToolPermissionRequest }
  | { type: "compaction_start";
     reason: "manual" | "threshold" | "overflow" }
 | { type: "compaction_end";
     reason: "manual" | "threshold" | "overflow";
     ok: boolean; tokensBefore?: number; firstKeptMessageId?: string;
     willRetry: boolean; fallback?: "retained_tail";
     mark?: { id: string; throughMessageId: string;
              generation: number; summaryTokens: number;
              summarized: boolean };
     error?: { code: string; message: string } }
 | { type: "error"; error: AppError }
 | { type: "status"; status: AgentStatus };
```

> 这些是 **UI 标准化事件**，而不是原始 pi 事件的传递。
> `packages/agent-runtime` 负责将 pi 事件映射到此模型。

`planning_state` 是代理运行时的本地规划投影。其可选的
提案和执行字段镜像共享 `PlanningStateEvent` 形状
（`proposal`、`executionId` 和 `executionState`）。完全批准执行
描述符使用`PlanExecution`并由主机result/notification携带。
权威主机 approval/queue 转换是单独的 `plans.changed`
通过 `IPC.event.plansChanged` 转发的通知。
`tools.output` 是 `packages/agent-runtime` 使用的主机通知
当 Bash 工具运行时；它不是代理事件。

`turn_end` 关闭 model/tool 一轮但不是终端桌面运行事件：
可能会立即提出另一个提供商的请求。 Renderer 繁忙状态和
因此，持久回合完成仅在 `agent_end` 或 `error` 上确定。
压缩始终是内联的：`compaction_start` 使运行保持忙碌，手册
操作取决于其匹配的 `compaction_end` 和 threshold/overflow
压实保留在活性剂运行内。没有预先计算的阶段
区分（D203）。

只要安装了检查点，`compaction_end.mark` 就会出现。它是
渲染器对该压缩的整体视图：`id`，`throughMessageId` 锚定
成绩单行位于 `generation` 之后（此会话有多少个检查点
已安装）、`summaryTokens`（摘要的估计上下文成本）以及
`summarized`（当窗口滚动且未向模型询问时，`false`
总结）。记录本身不被携带——它的摘要和保留尾部被携带
远远大于事件应有的大小——而是从
`SessionDetail.compactions` 会话打开或分叉。

自动摘要失败仍可能产生成功的生命周期事件
`fallback: "retained_tail"`；这意味着有一个耐用的、有边界的尾巴
检查点已安装，运行可能会继续，但历史记录会减少
上下文。手动压实永远不会悄无声息地倒退。

提供程序 `error` 事件可能包括以下中的有限诊断字段：
`AppError.details`：`phase`（`request` 或 `stream`）、`providerStatus`、
`providerCode`、`providerWaitMs`、`streamMs` 和 `retryAttempt`。这些领域
是添加和编辑的；他们从不携带凭证或不受限制的
提供商响应。瞬时流故障可能会在内部重播
同一回合，没有终端 `error` 事件或重复的辅助消息。
第二次失败会发出终端标准化 `STREAM_FAILED` 错误。

## 6a。通知 API（D117，协议 v4）

持久收件箱请求已列入允许名单 preload 调用 Electron 转发
到单一主机 RPC 域，无需渲染器访问 SQLite：

- `pi-desktop/notification/list({ unreadOnly?, limit? })`
- `pi-desktop/notification/markRead({ id })`
- `pi-desktop/notification/markAllRead()`
- `pi-desktop/notification/clear()`

渲染器调用
`pi-desktop/notification/setViewingSession({ sessionId })` 每当聊天时
页面的活动会话发生变化； `sessionId: null` 清除查看上下文
非聊天页面。渲染器发起的 `agent/prompt` 也会携带匹配的
`viewingSessionId` 快照，Electron 会在异步回合初始化之前安装它，
避免快速完成先于查看上下文更新。Electron 将此提示与 Main 拥有的窗口
visibility/focus 结合起来，在终态事件边界进行判断。缺失、null 或不匹配的
上下文都会安全地创建公告。它还调用
`pi-desktop/notification/showNative({ id, sessionId, title, body })` 之后
本地化新记录。这个仅限电子的请求永远不会进入主机
RPC 域。

```ts
type AppNotification = {
  id: string;
  kind: "task.completed" | "task.failed";
  sessionId: string;
  sessionTitle: string;
  turnId: string;
  errorCode?: string;
  createdAt: string;
  readAt?: string | null;
};

type NotificationListResult = {
  notifications: AppNotification[];
  unreadCount: number;
};

type NotificationChangedEvent = {
  notification: AppNotification;
};

type NotificationActivatedEvent = {
  id: string;
  sessionId: string;
};
```

Main 发送两个事件：

- `session.endTurn` 返回后的 `pi-desktop/notification/event/changed`
  新插入的记录。 Renderer 将记录合并到其有界本地列表中
  并重新计算确切的未读计数。最终结果已经可见
  聚焦的当前聊天、重复的终端更新和中止的回合会发出
  什么也没有。
- 用户点击 Electron 后的 `pi-desktop/notification/event/activated`
  本机系统通知。 Renderer 遵循其现有的会话选择
  路径，包括项目绑定会话的项目激活。

Electron 拥有本机表面，而渲染器则派生本地化表面
结构化记录中的 title/body 文本。 Electron 仅接受 `showNative`
对于有效的 notification/session 对，仅在以下情况下显示本机通知
主窗口未聚焦且支持平台 API，则
restores/shows 并在发出 `activated` 之前聚焦窗口。没有
集中注意力且没有权限时的本机通知、计划提醒或
本合同中的插件源。本地交付是尽力而为；耐用的
当操作系统抑制横幅时，收件箱仍然具有权威性。在 Windows 上，
Electron 主将 `com.pi-desktop.app` 注册为进程 AppUserModelID
在准备就绪之前和创建任何窗口之前。 ID 与 NSIS 匹配
包标识所以通知属性、通知设置、任务栏
分组，安装的快捷方式解析为 `PI-Desktop`，而不是库存
Electron 主机。

查看会话提示是建议性的和自动防故障的：丢失、陈旧、隐藏或
未聚焦的渲染器状态会创建持久通知。发生抑制
仅当主窗口可见且聚焦且报告的聊天会话时
与收尾阶段相匹配。窗口创建、渲染器重新加载和渲染器
进程丢失在评估任何后续终端事件之前清除提示。

## 7. 会话 API

```ts
type SessionSummary = {
 id: string;
 title: string;
 projectPath?: string;
 modelId?: string;
 providerId?: string;
  mode: "plan" | "goal" | "agent";
 thinkingLevel: ThinkingLevel;
 supportsReasoning?: boolean;
 supportedThinkingLevels?: ThinkingLevel[];
 updatedAt: string;
 createdAt: string;
};

type UiMessage = {
 id: string;
 role: "user" | "assistant" | "system" | "tool";
 content: string;
 thinking?: string; // assistant reasoning, never folded into content
 usage?: MessageUsage; // provider-reported assistant usage
 responseDurationMs?: number; // model stream duration for throughput
 responseOutputTokens?: number; // estimated partial output when stop has no final usage
 toolName?: string;
 toolCallId?: string;
 toolArgs?: unknown;
 toolResult?: unknown;
 toolUsage?: ToolTokenUsage; // estimated tool call/result footprint
 error?: AppError;  // structured failure owned by this assistant turn
 createdAt: string;
 // Rows produced inside a subagent (D201, ADR 0062); absent on the session's own
 parentToolCallId?: string;   // `Task` call that spawned the delegate
 agentName?: string;          // delegate definition name
 // status/tool fields omitted here
};

type ToolTokenUsage = {
 argumentTokens: number;
 resultTokens: number;
 totalTokens: number;
 estimated: true;
};

type SessionDetail = SessionSummary & {
 messages: UiMessage[];
};
```

Electron 主进程用该会话精确 provider/API URL 与 model 的本地 models.dev
记录，丰富 session list/get/create/fork/configure 结果中的有效推理能力。
未固定 `providerId`/`modelId` 的会话仅在此丰富步骤继承应用默认供应商/模型；
持久化 id 保持为空，以便之后的默认模型变更仍然生效。快照中没有该 ID、或
会话无法解析出默认目标时，得到 `supportsReasoning: false` 和 `off`；缓存/
供应商声明不能取代目录语义。Rust 主机仅对持久化的 `thinkingLevel` 权威。

全局插件启动器使用仅 Electron 允许的通道：

- `pi-desktop/pluginLauncher/toggle` 显示或隐藏居中的实用程序窗口
- `pi-desktop/pluginLauncher/dismiss` 仅在被该窗口调用时才隐藏它
- `pi-desktop/pluginLauncher/event/shown` 重置其查询，重新加载安装
  插件，并在每次调用后恢复输入焦点

启动器重用 `plugin/list` 和 `plugin/openPanel`；它不添加 host-core
插件 RPC。 Electron主进程还调用了附加宿主方法
`keyboard.setGlobalShortcut({ binding })` 用于启用仅限 Windows 的回退
用于保留的 `Alt+Space` 绑定。主机核心发出通知
`keyboard.shortcut({ binding: "Alt+Space" })` 当其低电平时 Windows
键盘钩子检测和弦；钩子消耗了那个和弦，所以活动的
窗口系统菜单打不开。非 Windows 主机将该方法视为
无操作。 `responseDurationMs` 和 `responseOutputTokens` 是可选的转录本
元数据保留在消息元数据中，因此协议 v10 和存储架构 v12
保持不变。

设置字体选择器（ADR 0083）通过一个仅 Electron 的允许通道读取
系统已安装字体：

- `pi-desktop/app/systemFonts` 返回 `string[]`，即系统已安装字体的
  字体系列名称（Electron 主进程使用平台工具——macOS 用
  `system_profiler`、Windows 用 PowerShell、Linux 用 `fc-list`），
  去重、排序并排除隐藏的 `.` 前缀字体系列。主进程将结果缓存
  60 秒；失败时解析为 `[]`。主机 RPC 与协议版本不变。

最小接口：

- `session/list`
- `session/create`
- `session/fork({ sessionId, title?, throughMessageId? }) -> { session: SessionDetail }`
- `session/get`
- `session/delete`
- `session/rename`
- `session/importScan`
- `session/importRun(candidates) -> { imported, skipped, failed }`

导入候选者携带 `projectPath: string | null`。导入成功
刷新会话和持久项目索引。

`session/fork` 是一个协议 v5 通道，可创建独立的
来自源会话当前活动记录的会话。当可选时
`throughMessageId` 存在，复制的快照以该消息结束；一个
未知 ID 返回 `NOT_FOUND`。 Electron 拒绝
当该源会话处于活动状态时，使用 `AGENT_BUSY` 发出请求。
Electron拥有本地化并提供面向用户的分支名称；主机
后备标题是为非 UI 调用者保留的。
主机分配新的会话 ID、消息 ID 和工具调用 ID；它复制
耐用的 project/provider/model/mode/thinking/permission 配置，但是
不复制回合、通知、工件、暂存数据、权限
授予，或重新生成修订。源会话保持不变。
消息范围的助手 Fork/Edit 使用此选项，以便子进程收到
新的会话 ID，因此无法重用或改变源 pi 运行时或
它的提供商缓存。

协议版本 9 添加检查点 Plan 合约：`SubmitPlan`，唯一
`.pi/plan/*.md` 工件元数据、approve/reject-only 响应、绝对
到期、`plan_approvals` 执行字段、shell catalog/identity 字段以及
直播 stdout/stderr 事件。 v7 或更旧的主机，以及任何不兼容的 v8
对等方，握手必须失败，以便桌面无法静默显示 Plan
丢失工件、队列、shell 或策略边界。
`pi-desktop/agent/compact` 和 `session.appendCompaction` 仍然是 v9 的一部分
合同。 Goal 合约在 v9 (**D198**) 中是附加的：`kind` 是可选的
在线且缺席意味着 `plan`，因此早于 Goal 的对等点继续工作
并且根本不进行谈判。

协议版本 2 添加了 `thinkingLevel`、`UiMessage.thinking` 和
`message_update.deltaThinking`。 v1 对等方必须通过版本检查
默默地丢弃这些字段。

`UiMessage.error` 是可选的附加字段。提供商失败附加
生命周期 `error` 事件携带的相同标准化 `AppError`
`message_end` 之前的助理消息。错误消息仍然存在
转录本，但被排除在恢复的模型上下文之外。

上下文检查器消耗两个附加使用信号。 `MessageUsage` 是
提供商报告的助理使用情况，`responseDurationMs` 是已用时间
sidecar 用于显示每秒输出令牌的流时间。 `ToolTokenUsage`
是根据工具调用参数和结果估计的运行时间；提供商不
报告每个工具的分配，因此渲染器将这些行标记为估计值并
永远不会将它们合并到确切的提供商总数中。年长的同行可能会忽略所有
这些可选字段不会破坏 v6 握手。

## 8. 设置/秘密 API

### 设置
可以返回到UI的非敏感配置：

- 提供商列表（无秘密明文）
- 默认模型
- 从主机 shell 目录中保留 `defaultCommandShell`
- 持久化的 `largePasteThreshold`（大段纯文本 Composer 粘贴使用）；主机将缺失值
  读取为 600，并接受 1 至 1,000,000 的整数
- 权限策略切换
- UI 首选项，包括可选的 `AppSettings.keybindings` 覆盖键控
  通过共享快捷操作 ID；值可以是 `null` 或便携式 `Mod+Shift+Key` 字符串，
  不包含特定于平台的本机加速器字符串。缺少属性使用平台默认值，`null` 表示
  明确禁用（未绑定）
- 可选的 `AppSettings.developerMode`；缺席和 `false` 均保留开发人员
  工具已禁用

`settings.set` 接受部分设置对象。提供主机核心合并
字段写入存储的应用程序设置，因此省略字段，包括
`defaultCommandShell`，均保留。只有传入的shell字段才是shell
已验证；空闲的 Plan/configuration 门仅在其有效 shell 时运行
会改变的。当前有效的无关写入和幂等写入
当工作正在进行时，shell 仍然被接受。遗产
`planApprovalPermissionMode` 被忽略并从当前读取中剥离，
写道；它不会被暴露或重新创建。

### 外壳

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
```

预加载方法：

- `pi-desktop/commandShell/list() -> CommandShellCatalog`
- `pi-desktop/settings/set({ defaultCommandShell }) -> { ok: true }`

设置 shell 写入仅接受当前平台的可用 ID，并且
拒绝未知、不可用或错误的平台 ID。真正有效的外壳
仅当所有会话和 Plan/Goal 工作空闲时才接受更改。如果一个
持久化 ID 稍后变得不可用，目录选择第一个可用的
平台外壳并设置 `fallback: true`；如果没有可用的选择，则 Bash
返回 `SHELL_NOT_FOUND`。
每回合固定有效 ID 和方言。运行时传输这两个值；
主机在权限评估之前和生成之前拒绝更改的引脚
`COMMAND_SHELL_CHANGED`。

### 秘密
- `secrets/set(providerId, apiKey)`
- `secrets/delete(providerId)`
- `secrets/has(providerId) -> boolean`

禁止：
- 将完整的 API 密钥写入普通日志
- 在渲染器中长期保留 API 密钥明文

### 厂商账户（OAuth，D237）

用厂商订阅账户登录是 Electron 主进程内的会话，因此只走 IPC —— 主机协议
版本不变。五条调用通道加一条事件通道：

- `pi-desktop/providers/oauth/vendors() -> { vendors: OAuthVendor[] }`
- `pi-desktop/providers/oauth/start({ vendorId }) -> { loginId }`
- `pi-desktop/providers/oauth/respond({ loginId, promptId, value? })` ——
  不带 `value` 表示取消该提问，从而中止整个流程
- `pi-desktop/providers/oauth/cancel({ loginId }) -> { ok: boolean }`
- `pi-desktop/providers/oauth/logout({ vendorId }) -> { ok: true }`
- `pi-desktop/providers/oauth/event` 推送 `OAuthLoginEvent`

```ts
type OAuthLoginEvent = { loginId: string; vendorId: string } & (
  | { kind: "info"; message: string; links?: Array<{ url: string; label?: string }> }
  | { kind: "authUrl"; url: string; instructions?: string; opened: boolean }
  | { kind: "deviceCode"; userCode: string; verificationUri: string;
      intervalSeconds?: number; expiresInSeconds?: number }
  | { kind: "progress"; message: string }
  | { kind: "prompt"; request: OAuthPromptRequest }
  | { kind: "promptCancelled"; promptId: string }
  | { kind: "done"; providerId: string; accountLabel?: string }
  | { kind: "error"; message: string }
  | { kind: "cancelled" }
);
```

流程可能在 `start` 回复之前就抛出第一个事件 —— OpenAI Codex 在登录开始的
同一个 tick 里就询问「浏览器还是设备码」—— 因此渲染层必须**先**订阅事件通道
再调用 `start`，把 `loginId` 未知期间到达的事件暂存下来，等回复到达后按序
放行匹配的那些。回复之后才订阅会丢掉第一个提问，流程便会一直等待一个从未
显示给用户的问题。

`start` 每次尝试还必须**只调用一次**，且发自用户操作而非 React effect ——
StrictMode 会在挂载时把 effect 跑两遍，第二次尝试会再开一个浏览器，并与第一次
争抢同一个本地回调端口。渲染层的会话对象保留它已投递的全部事件，并向后来的
订阅者重放，因此对话框可以挂载、卸载、再挂载而不会重启任何东西。主进程从自己
一侧守同一条不变量：对某厂商发起 `start` 时，若该厂商仍有尝试在飞行中，先取消
它并等它完全收尾，再开始新的一次。

所有登录形态 —— 浏览器回调、设备码、手动贴码、厂商选项 —— 都走这一条
事件流，因此渲染层只渲染收到的内容，而不按厂商分支。`opened: false` 表示
浏览器无法启动，用户需要自己复制链接。`promptCancelled` 表示流程自己回答了
某个提问（回调赶在了贴码框前面），因此输入框必须自行消失。

同样禁止：任何事件都不携带令牌、刷新令牌或授权码。`accountLabel` 只是
展示字符串。

## 9. API 项目

- `project/open()`：系统目录选择器
- `project/openFolder(path)`：打开系统文件中已知的项目目录
经理
- `project/get()`：当前工作空间
- `project/list()`：持久的项目记录，包括导入创建的条目
- `project/set(path)`：设置工作空间
- `project/clear()`

返回：

```ts
type ProjectWorkspace = {
 path: string;
 name: string;
};

type ProjectRecord = {
 id: number;
 path: string;
 name: string;
 pinned: boolean;
 createdAt: number;
 lastOpenedAt: number;
};
```

## 10. 工具权限API

当工具需要确认时：

1.主发送`tool_permission_request`
2. UI显示确认卡
3.UI调用`tool/resolvePermission`

```ts
type ToolPermissionRequest = {
 requestId: string;
 sessionId: string;
 toolCallId: string;
 toolName: string;
 argsPreview: unknown;
 risk: "low" | "medium" | "high";
 reason: string;
 /** Definition name when a subagent asked (D201, ADR 0062); absent for the
  * session's own calls, together with the `Task` call that spawned it. */
 agentName?: string;
 parentToolCallId?: string;
};

type ToolPermissionResolution = {
 requestId: string;
 decision: "allow-once" | "allow-session" | "deny";
};
```

一旦运行并行子代理，一个会话就可以容纳多个打开的请求。
渲染器按会话对它们进行排队，并首先回答最旧的；决议
合约未更改，因为它已由 `requestId` 键入
（`04-ux/03-permission-ux.md` §6a）。

Plan 不会取代此通用许可合同。 Plan `Bash` 调用
使用正常的会话范围权限流：`ask` 和 `accept-edits` 发出
工具权限请求，而 `auto` 执行时无需确认。 Plan
批准是一个单独的状态转换，并且始终使用 `plan` 方法
上面。

## 11. 版本兼容性

- IPC/host 合约版本字段：`protocolVersion: 10`
- 重大更改必须提升版本并记录 ADR
- 渲染器和主程序在启动时验证版本；不匹配时，提示 upgrade/reinstall
- 协议 v4 增加了通知记录、通道和
  带有通知的 `session.endTurn` 结果。 v3 对等点被拒绝
  而不是默默地丢失持久的 completion/failure 事件。
- 可选的查看会话调用和 `createNotification` 结束回合字段
  是附加的 v4 行为。年长的调用者省略该字段并保留
  创建通知的故障安全默认值。
- 协议 v5 添加了所需的 `session/fork` 快照操作。 v4 对等点是
  在聊天变得交互之前被拒绝而不是公开分支
  只能在调用时失败的命令 (ADR 0023)。
- 协议 v6 添加了持久上下文检查点以及 manual/lifecycle
  渠道。 v5 对等点被拒绝，因为默默地忽略检查点可能会导致
  使下一个提供商请求不安全（ADR 0030）。
- 协议 v9 取代了早期的 v7 Plan 合约。它添加了 `SubmitPlan`，
  精确独特的工件元数据，approve/reject-only 分辨率，30 分钟
  绝对到期、`plan_approvals` 执行状态、shell 选择和
  固定 ID/dialect，并流式传输命令输出。 v7/v8 对等点被拒绝
  在 UI 变得交互式之前，因为它无法强制或表示这一点
  边界（ADR 0053/0054）。 `SubmitGoal` 和可选的 `kind` 鉴别器
  在 v9 中运行，不需要版本冲突，因为缺少 `kind` 是
  正是目标前的行为。

## 12. 插件 API（主机 UI 端）

最小接口：

- `plugin/list`
- `plugin/loadDev(path)`
- `plugin/reload(id)` — 从其存储中重新加载已注册的开发插件
  路径并刷新其权限上限
- `plugin/installFromPath(path)`
- `plugin/enable(id)`
- `plugin/disable(id)`
- `plugin/uninstall(id)`
- `plugin/getPermissions(id)`
- `plugin/setPermission(id, permission, allowed)`（可选细粒度）
- `plugin/setScope(id, scope)` (D192)

返回摘要：

```ts
type PluginSummary = {
 id: string
 name: string
 version: string
 enabled: boolean
 source: "installed" | "dev"
 status: "ready" | "error" | "disabled"
 errorMessage?: string
 permissions: string[]
 scope?: ActivationScope
}
```

## 12a。用户 MCP 服务器 API (D193)

用户拥有的 MCP 配置按 ID 写入以下目录中的单个 JSON 文件：
`~/.agents/servers/<id>.json` 或 `<project>/.agents/servers/<id>.json`。
启用状态不写入这些文件，而是存放在应用本地的
`<data>/agent-capabilities/mcp.json`。

- `mcp.list({ level, projectPath? })` → `{ servers: McpServerRecord[]; statuses: McpServerStatus[] }`
- `mcp.active({ projectPath? })` → 当前项目的有效运行时列表
- `mcp.upsert(server)` — 在请求的级别创建或替换文件
- `mcp.remove({ id, level, projectPath? })`
- `mcp.setEnabled({ id, enabled, level, projectPath? })`
- `mcp.setScope` 保留为兼容形状；设置页改用显式能力级别和本地状态

项目级请求缺少 `projectPath` 时无效。`mcp.active` 会先按 ID 或不区分大小写
的 label 让项目记录遮蔽全局记录，再过滤关闭项；因此关闭的项目记录仍然会
遮蔽全局项。仅桌面的 `mcp/test` IPC 操作用于强制连接测试，并把状态返回
MCP 编辑器。

```ts
type McpServerStatus = {
 serverId: string
 state: "idle" | "connecting" | "ready" | "failed"
 toolCount: number
 toolNames?: string[]
 message?: string
 updatedAt: number
}
```

工具以 `mcp_<serverId>_<toolName>` 的形式到达代理，与插件桥的
`plugin_` 命名空间分离 (D015)。

## 12b。用户技能 API (D194)

用户技能是从 `~/.agents/skills` 和 `<project>/.agents/skills` 扫描的 Markdown
文档，同时接受直接 Markdown 文件和约定的 `<skill>/SKILL.md` 形状。启用状态
位于 `<data>/agent-capabilities/skills.json`，绝不写回技能文档。

- `skills.list({ level, projectPath? })` → `{ skills: UserSkillRecord[] }`
- `skills.active({ projectPath? })` → 当前项目的有效运行时列表
- `skills.create(skill)`
- `skills.import({ path, level, projectPath? })` — 将一个源文件物理复制到选定的
  `.agents/skills` 目录
- `skills.update({ id, ...skill })`
- `skills.read({ id, level?, projectPath? })` → `{ skill, body }`
- `skills.remove({ id, level?, projectPath? })`
- `skills.setEnabled({ id, enabled, level, projectPath? })`

列表包含由 frontmatter 得出的 `name` 和 `description`，不包含正文。只有描述
进入提示，模型调用 `Skill` 时才读取正文 (D174)。缺失文件会在下一次扫描时
从列表移除，并清理其本地状态。

## 12c。子代理 API (D202)

用户拥有的子代理仅是全局 Markdown 文档：`~/.agents/subagents/<id>.md`。
没有项目级子代理目录。启用状态写在
`<data>/agent-capabilities/subagents.json`，绝不写入 Markdown 文件。

- `agents.list` → `{ subagents: UserSubagentRecord[] }`
- `agents.active` → 已启用的全局文档
- `agents.create(subagent)` — 重名返回 `SUBAGENT_INVALID`
- `agents.update(id, subagent)`
- `agents.read(id)` → `{ subagent, body }`
- `agents.remove(id)`
- `agents.setEnabled(id, enabled)`

Electron 的 `subagent/list` IPC 通道向设置 > 智能体 > 子代理暴露同一份全局
列表。运行时目录把这些全局用户文档与内置定义合并；不会扫描 `.pi/agents`
或任何项目能力目录。

## 12d。能力级别与本地启用状态

技能和 MCP 管理调用使用：

```ts
type AgentCapabilityQuery = {
 level: "global" | "project"
 projectPath?: string
}
```

全局项默认启用，并可在当前项目保存覆盖状态；项目项使用其所属项目的状态。
扫描时会清理已删除文件的本地状态；删除全局文件会一并删除它的所有项目覆盖。
这些记录独立于插件的 `ActivationScope`。

## 13. 命令面板 API

- `commandPalette/search(query)`
- `commandPalette/execute(commandId)`

命令来源：
- 内置命令
- 插件贡献.命令

## 13a。工作面板 API

工作面板通道是 Electron 主要的实现。用户驱动的工作区
操作从 `workspace.get` 解析可见根并失败关闭
没有一个。代理驱动的 BrowserPreview 路由解析原始
通过 `session.get` 进行对话，因此后台预览永远不会继承
可见会话的工作区。

### 工作区

- `workspace/diff()` → `WorkspaceDiff { repo, clean, files: DiffFile[], truncated? }`。
  此遗留诊断通道可以检查当前工作树，但它
  不是评论的真实来源。评论 UI 读取消息拥有的评论
  相反，来自转录工具结果的记录，因此提交无法删除
  记录的变化。
- `workspace/review/rollback({sessionId, snapshotId})` →
  `ReviewRollbackResult`。主机在之前验证当前的后工具哈希
  恢复快照；它返回 `rolledBack`、`alreadyRolledBack`、
  `conflict` 或 `unavailable` 并且永远不会覆盖冲突的后续编辑。

### 浏览器 (D100)

- `browser/navigate({url, sessionId?})`（方案标准化；http/https 工作
  没有工作空间，而本地路径需要提供的会话的
  持久的项目根目录或遗留调用的可见工作区），
  `browser/action({action: back|forward|reload|stop})`，
  `browser/setBounds({x,y,width,height})`（渲染器测量的内容矩形），
  `browser/setVisible({visible})`、`browser/openExternal()`、
  `browser/getState()`
- 事件：`browser/event/state {url, title, isLoading, canGoBack, canGoForward}`
- 代理预览活动：`browser/event/preview {sessionId, path}`。 Electron 主要
  在发出之前验证该会话项目内的 `path`；渲染器
  将其记录在匹配的运行时面板上下文中，并仅在该情况下进行导航
  对话可见。

### fs（只读）

- `fs/list({path})` → 条目首先按目录排序；忽略 `.git`，
  `node_modules`，默认忽略子集
  [15-工作区-忽略-规则](/zh-CN/spec/03-runtime/15-workspace-ignore-rules)
- `fs/read({path})` → 文本 (≤512KB) / 图像数据 URL (≤5MB) / 二进制 / 太大
- `fs/reveal({path})` → 在 Finder 中显示
- 每个路径都在工作空间根目录内解析；外面的遍历是
  被拒绝（`INVALID_ARGUMENT`）。

## 13b。桌面菜单和窗口 API

preload 公开同步、只读 `platform: NodeJS.Platform`
值，以便渲染器选择本机 macOS chrome 或无菜单 Windows/Linux
第一次喷漆前无框镀铬。

主渲染器应用程序命令使用一个列入白名单的事件：

```ts
type AppMenuCommand =
  | "newTask" | "openProject" | "openSettings"
  | "openCommandPalette" | "toggleSidebar"
  | "openHelp" | "openLogs" | "checkForUpdates";

event: menu/event/command { command: AppMenuCommand }

menu/rendererReady() -> { ready: true }
```

渲染器在调用之前订阅 `menu/event/command`
`menu/rendererReady`。当本机菜单出现时，Main 会等待该确认
命令创建或重新加载窗口，因此启动计时不能删除第一个
命令。

渲染器拥有的 Windows/Linux 键盘快捷键执行缩放和全屏
通过 `menu/nativeAction` 进行操作。保留的兼容面
还支持编辑和窗口操作。其请求仅限于
导出的 `NATIVE_MENU_ACTIONS` 元组；未知的价值观会失败而不是成为
通用主进程命令界面：

```ts
type NativeMenuAction =
  | "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll"
  | "reload" | "zoomIn" | "zoomOut" | "resetZoom"
  | "toggleFullScreen" | "minimize" | "toggleMaximize" | "close";

menu/nativeAction({ action: NativeMenuAction })
  -> { maximized: boolean; fullScreen: boolean }
```

开发人员工具使用专用的 Main 拥有的门，而不是通用的本机
菜单操作：

```ts
devtools/toggle({ open?: boolean }) -> { open: boolean }
```

当 `AppSettings.developerMode` 不是 `true` 或 no 时，Main 拒绝请求
实时窗口存在。所有平台上存储的旗门F12相同，
在 Windows/Linux 和 macOS 视图菜单角色上按 Ctrl+Shift+I。禁用标志
关闭已经打开的开发人员工具窗口。

`window/control` 接受导出的 `WINDOW_CONTROL_ACTIONS` 元组：

```ts
type WindowControlAction =
  | "getState" | "minimize" | "toggleMaximize" | "close";

window/control({ action: WindowControlAction })
  -> { maximized: boolean }
```

Windows/Linux 的关闭行为（D230、ADR 0090）通过两个附加的、由主进程拥有的
通道读写。`closeBehavior/get` 返回持久化的偏好以及该平台是否支持它
（macOS 保持原生 Dock 生命周期，报告 `supported: false`）；
`closeBehavior/set` 接受一个可设置的 `CloseBehavior`（`tray` 或 `quit`）
并将其持久化：

```ts
type CloseBehavior = "ask" | "tray" | "quit";

window/closeBehavior/get -> { behavior: CloseBehavior; supported: boolean }
window/closeBehavior/set({ behavior: "tray" | "quit" })
  -> { behavior: "tray" | "quit" }
```

`ask` 是 `get` 报告的、尚未设置的过渡态，它永远不可设置 —— 首次关闭只问
一次，一旦存在选择就只能切换，不能退回到每次询问。`ask` 和未知值以
`INVALID_ARGUMENT` 失败而不是被强制转换；在 macOS 上 `set` 同样如此失败，
因为那里没有可配置的关闭行为。设置行为不会触碰托盘图标：D216（ADR 0078）
在每个平台上启动时都会创建一个，而无论存的是哪种关闭行为，最小化到托盘都
需要它。

Maximize/unmaximize 变化也会发出
`window/event/maximized`。未知的操作失败。这些仅限电子的通道
不要跨入 host-core，也不要更改主机 RPC 协议版本。
preload 故意不公开任意的 BrowserWindow 调整大小通道。
特定于几何形状的能力是有界的目标状态工作面板保留与聊天宽度更新
（D163、D255，ADR 0032/0122）：

```ts
window/setWorkPanelReservation({ width: 0 | number })
  -> { requested: number; reserved: number }
```

`width` 必须是等于 `0` 或在 JSON 内的有限整数
包括 `244..720` 范围。字符串、布尔值、null、小数值和
其他格式错误的有效负载会因 `INVALID_ARGUMENT` 而失败，而不是
被胁迫。零是 closed/collapsed 目标，正值是
可见面板的承诺固定宽度。 `requested` 是接受的当前目标。
`reserved` 是当前添加的原生宽度
到该目标的正常基本窗口，并且可以小于 `requested`
仅当显示工作区域不足时。调用是幂等目标
更新：重复相同的宽度不会添加另一个增量。

面板打开时，两条可见的调整边界有不同的归属：

```ts
window/setWorkPanelChatWidth({ width: number })
  -> { requested: number; applied: number }

window/event/workPanelResize
  -> { phase: "preview" | "commit"; panelWidth: number }
```

`window/setWorkPanelChatWidth` 只接受 `1040..10000` 闭区间内的安全整数。
它是窗口内渲染器拥有的分隔条使用的有界目标状态通道；它改变基础对话
宽度，同时保留当前生效的面板保留量。工作区紧张时，聊天目标停在仍能容纳
该保留量的最大基础宽度上；面板绝不会作为副作用被收窄。原生右边缘（以及
Electron 报告的右侧角）改变的是面板目标。Main 通过
`window/event/workPanelResize` 预览该原生面板宽度，并在原生调整流稳定后
提交给渲染器。面板目标仍限定在 `244..720px`。

正常状态下，Main 向右扩展基边界并向左移动
仅根据需要将扩展边界保留在当前显示工作范围内
区。零目标对称地消除了增加的宽度并反转了这一点
保留引起的转变。 Main 仍然保留基界，并且移除了这两种效果。
来自左边缘或非右侧角的本机手势仅更新那些基边界，留下 `requested` 和
渲染器拥有的固定面板宽度不变。外侧右边缘和右侧角更新面板目标，而基础
对话宽度保持固定。最大化和全屏窗口
记住最新的目标但推迟几何；恢复正常协调
它一次针对恢复的基础边界和当前工作区域。如果窗户
管理器首先在显示期间压缩或重新定位外部窗口，或者
工作区转换，协调保留最后确认的基界；
返回到更宽敞的工作区域会恢复原始的聊天宽度。该保留仅适用于
窗口管理器的调整。用户拖动窗口期间发生的跨显示器变化归因于
用户（D263、ADR 0132）：放下的位置成为新的基边界，仅其原点被
规范化进目标显示器工作区域，并且这一位置会被持久化用于下次启动。
即使目标工作区域更窄，基础尺寸也会保留，因此收缩的是 `reserved`
而不是窗口。Main 会把这次协调推迟到本机移动流稳定之后，
所以拖动过程中不会应用任何保留几何。 Renderer 代码
仅针对当前可见的会话设置此目标：背景工件
无法更改可见的保留几何形状。

## 13c。 Composer 输入 API（D123/D124/D197、ADR 0024/0059）

仅电子通道支持输入框自动完成和剪贴板文件
参考。 `composer/commands` 和 `fs/index` 是只读且软故障；
`composer/pasteFiles` 仅写入原始会话的 Electron 拥有的
暂存目录。 None 添加主机 RPC 方法或更改主机协议
版本。

### composer/commands

```ts
composer/commands() -> { commands: ComposerCommand[] }

type ComposerCommand = {
  /** Slash name typed after "/", unique across the merged list. */
  name: string;
  kind: "template" | "builtin" | "plugin";
  title: string;            // display title (templates: name)
  description?: string;     // template frontmatter / palette title
  argumentHint?: string;    // template frontmatter `argument-hint`
  source?: "project" | "user"; // template provenance
  id?: string;              // builtin/plugin palette id for execution
};
```

模板从 `<workspace>/.pi/prompts/*.md` 加载并
`~/.pi/agent/prompts/*.md`（项目赢得名称冲突；短 TTL 缓存）。
没有工作区，只有用户全局模板、内置函数和插件
命令返回。

### fs/index

```ts
fs/index() -> { entries: FsIndexEntry[]; truncated: boolean }

type FsIndexEntry = { path: string; kind: "file" | "dir" };
```

`@` 菜单的工作空间相对路径：`git ls-files -co
--exclude-standard`快速路径，忽略设置递归行走回退，
从文件路径派生的目录，8000 个条目上限，`truncated: true`，
每个根的短 TTL 缓存。无法关闭到空列表而没有
工作区。模糊过滤发生在渲染器端。

### composer/pasteFiles

```ts
composer/pasteFiles({ sessionId, files }) -> {
  files: ComposerPastedFile[];
}

type ComposerPasteFile = {
  name?: string;
  mimeType?: string;
  data: ArrayBuffer;
};

type ComposerPastedFile = {
  path: string;     // UUID-backed absolute storage path
  name: string;     // sanitized original leaf display name
  mimeType: string;
  size: number;
};
```

Electron main 验证 `sessionId` 是否解析为持久主机会话，
将请求限制为 20 个文件，每个文件 64 MiB，总共 128 MiB，条带
渲染器提供的目录组件，并在下面写上唯一的名称
具有独占创建语义的 `<data_dir>/scratch/<sessionId>/pasted/`。的
渲染器将返回的路径保存在瞬态参考状态，显示 `name`，
并将每个精确路径序列化为文本提示作为 `@` 参考
派遣。剪贴板字节永远不会进入持久提示或主机代理
消息。
无效会话和 malformed/oversized 负载失败并出现 IPC 错误，并且
该操作无法写入工作区。

### prompt/enhance

```ts
prompt/enhance({
  sessionId?: string | null;
  draft: string;
  providerId?: string;
  modelId?: string;
  thinkingLevel?: ThinkingLevel;
}) -> { enhancedDraft: string }
```

这是一次独立的一次性补全，没有会话历史、工具或附件。Electron main 负责解析
提供商/模型和凭据，因此渲染器永远拿不到密钥。空草稿、斜杠命令草稿、缺失模型
以及提供商失败都返回通用的 `Result` 错误包络。

### app/openFeedback（D313）

```ts
app/openFeedback() -> { ok: true }
```

Electron Main 构造固定的 GitHub bug 表单 URL
（`https://github.com/vastsa/PI-Desktop/issues/new?template=bug_report.yml`），
并用 `shell.openExternal` 打开。查询字段 `app-version`、`os` 和 `environment`
由主进程版本信息填充。渲染器不能提供 URL。离开该 origin 或模板的构造会被拒绝。
此通道不进入 host-core，也不改变 host RPC 协议版本。

## 14. 错误代码 — 初始注册表（可扩展）

| 代码 | 含义 |
|---|---|
| `AGENT_BUSY` | 当前会话已经有一个正在运行的轮次 |
| `AGENT_NOT_FOUND` | 会话不存在 |
| `MODEL_NOT_CONFIGURED` | 无可用模型 |
| `PROVIDER_SECRET_MISSING` | 缺少 API 密钥 |
| `TOOL_DENIED` | 权限被拒绝 |
| `TOOL_TIMEOUT` | 工具超时 |
| `WORKSPACE_REQUIRED` | 需要项目目录 |
| `PATH_OUTSIDE_WORKSPACE` | 在明确的外部路径权限决策之前路径超出范围 |
| `INTERNAL` | 未分类的内部错误 |
