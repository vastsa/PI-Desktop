# 19. 远程 Agent 控制协议

- 协议：`PI Remote Agent Control Protocol`（`RACP`）
- 版本：`1.0`
- 状态：目标规格，属于 MVP 之后
- 决策：D373 / ADR 0205，经 D374 与 D375 修订
- 英文源规格：[英文源规格](/spec/03-runtime/19-remote-agent-control-protocol)

英文页面是规范源。本页保留协议字段、方法名、错误码和代码结构，便于
中文读者检索；实现必须以英文规范中的完整定义为准。

## 1. 边界与术语

RACP 控制 Agent Host，不是 Electron IPC、`host.proxy`、Rust host-core
协议、provider proxy、本地 MCP 或子代理 A2A/Peer 协议。RACP v1 是桌面本地
能力的严格子集；§3 的远端 Host profile 是让桌面本身成为另一台机器上 `pi-host`
的客户端所需的 v1.1 扩展（D375），仍推迟的操作在保留表中列名。

| Term | Meaning |
|---|---|
| Host | 拥有会话并执行回合的 Agent Host |
| Client | 控制 Host 的 UI、CLI、原生应用或服务 |
| Gateway | 可选的认证路由层 |
| Session | 持久化会话及工作区/项目绑定 |
| Turn | 一次已准入 prompt 的完整生命周期，等于本地 `agent/prompt` 返回的 `turnId`，不是一个 `turn_start`/`turn_end` 模型轮次 |
| Item | 回合中的持久单位：消息、工具调用或压缩检查点 |
| Event | 会话或 Host 的有序状态/进度通知 |
| Durable event | 获得序号并保留用于回放的事件 |
| Ephemeral event | 实时投递、不编号、不回放的进度事件 |
| Epoch | Host 为会话一段连续序列流生成的标识 |
| Cursor | 会话持久事件流中的 `{ epoch, sequence }` 位置 |
| Principal | 认证后的用户、设备、服务或 Gateway 身份 |
| Binding | RACP 操作的传输编码 |
| Host link | Gateway 到 Host 的出站连接，中继多个逻辑客户端连接 |

## 2. 初始化和消息

连接必须先发送 `connection/initialize`，完成响应和
`notifications/initialized` 后才能使用其他方法。响应带有能力、限制和只读的
`policy`（远程权限上限、审批寿命）。JSON-RPC over WSS 每帧一个 UTF-8 消息；
HTTP/SSE 使用 POST 命令和带 `Last-Event-ID` 的事件流。资源以
`packages/shared` 中的 typebox schema 为唯一来源，JSON Schema 与未来的 proto
均由其生成。

```json
{"jsonrpc":"2.0","id":"init-1","method":"connection/initialize"}
```

```json
{"protocolVersion":"1.0","capabilities":{"turnQueue":true,"hostEvents":true,"remoteHostProfile":true,"toolRelay":true,"terminal":true},"bindings":["RACP-WS"],"policy":{"remoteMaxPermissionMode":"ask","applyCeilingToPairedDevices":false,"approvalLifetimeMs":1800000}}
```

```ts
type RequestContext = { requestId: string; idempotencyKey?: string; expectedRevision?: number }
```

```ts
type Session = { id: string; title: string; mode: "agent" | "plan" | "goal"; planningState: string; queuedTurnIds: string[]; revision: number }
```

```ts
type Turn = { id: string; sessionId: string; status: "queued" | "running" | "completed" | "interrupted" | "canceled"; admission: "reject_if_busy" | "queue"; effectivePermissionMode: string }
```

```ts
type EventEnvelope = { scope: "session" | "host"; epoch: string; sequence?: number; afterSequence?: number; revision: number; kind: string; parentToolCallId?: string; payload: unknown }
```

```ts
type SessionSnapshot = { session: Session; items: ItemSummary[]; activeItems: ItemSummary[]; queuedTurns: Turn[]; pendingApprovals: ApprovalRequest[]; cursor: { epoch: string; sequence: number }; revision: number }
```

```ts
type ApprovalRequest = { id: string; kind: "tool" | "plan" | "goal"; allowedDecisions: string[]; allowedPermissionModes?: string[]; expiresAt: string }
type InputRequest = { id: string; turnId: string; questions: Array<{ id: string; question: string; options: string[]; multiSelect: boolean }> }
```

```ts
type Attachment = { id: string; sizeBytes: number; sha256: string; status: string }
```

```ts
type HostSummary = { id: string; label: string; status: "online" | "offline" }; type ProjectSummary = { id: string; label: string }
```

```json
{"sessionId":"ses_01J","role":"controller","after":{"epoch":"ep_7f","sequence":314}}
```

```json
{"session":{"id":"ses_01J"},"replayComplete":true,"snapshot":{"cursor":{"epoch":"ep_7f","sequence":314}}}
```

```json
{"scope":"session","sessionId":"ses_01J","after":{"epoch":"ep_7f","sequence":314}}
```

```json
{"subscriptionId":"sub_01J","starting":{"epoch":"ep_7f","sequence":315},"replayComplete":true}
```

```json
{"sessionId":"ses_01J","idempotencyKey":"turn-client-7f9c","admission":"queue","input":{"text":"Inspect the test."}}
```

```json
{"accepted":true,"turn":{"id":"turn_01J","status":"queued","effectivePermissionMode":"ask"}}
```

```json
{"turnId":"turn_01J","reason":"user_requested"}
```

```json
{"approvalId":"approval_01J","status":"resolved","decision":"allow-session","alreadyResolved":false}
```

```json
{"sessionId":"ses_01J","beforeItemId":"item_01J","limit":100}
```

```json
{"jsonrpc":"2.0","id":"server-request-42","method":"approval/request"}
```

```text
POST /v1/approvals/{approvalId}:respond
```

```ts
type HostLinkFrame = { link: "racp-hostlink.v1"; type: "client.open" | "client.message" | "host.message" | "attachment.chunk"; clientConnectionId?: string }
```

```ts
type RemoteError = { code: string; message: string; retriable: boolean; traceId: string }
```

本地事件到 RACP 事件的映射固定如下；回合范围事件的 `payload.event` 原样携带
共享的 `AgentEvent`：

| Local `AgentEvent.type` | RACP `kind` | Durable | Notes |
|---|---|---|---|
| `agent_start` | `turn.started` | yes | 排队准入时先有 `turn.queued` |
| `agent_end` | `turn.completed` / `turn.interrupted` | yes | 中止或停止时为 `interrupted` |
| `error`（终止） | `turn.failed` | yes | 携带归一化 `AppError` |
| `turn_start`、`turn_end`、`status` | `turn.activity` | no | 模型轮次与活动阶段 |
| `message_start` | `item.started` | yes | `itemType: "message"` |
| `message_update` | `item.delta` | no | 内容在 `item.completed` 中完整 |
| `message_end` | `item.completed` | yes | 完整 `UiMessage` |
| `tool_start` | `item.started` | yes | `itemType: "tool"` |
| `tool_update` | `tool.progress` | no | 部分结果在 `item.completed` 中完整 |
| `tool_end` | `item.completed` | yes | 完整结果 |
| `compaction_start`、`compaction_end` | `item.started`、`item.completed` | yes | `itemType: "compaction"` |
| `planning_state`、`plans.changed` | `session.changed` | yes | 规划投影与契约审批状态 |
| `tool_permission_request` | `approval.requested` | yes | `kind: "tool"` |
| 带 `pending` 提案的 host `plans.changed` | `approval.requested` | yes | `kind: "plan"` 或 `"goal"`；解决时发出 `approval.resolved` 和 `session.changed` |
| `asktool_request` | `input.requested` | yes | 与本地 asktool 卡片相同的问题 |

`turn.completed` 对应本地 `agent_end`，而不是只关闭一个模型轮次的 `turn_end`。
终端通知仅发送给当前连接，不写入会话持久事件日志。`terminal.changed` 携带当前会话
序号但不分配新序号；`terminal.output` 携带 `afterSequence`，属于瞬态事件。输出只能从
终端的有界回放环恢复，绝不来自事件日志。

## 3. 资源和操作

会话由 Host 持久化并拥有 revision；回合是异步执行单位，可立即准入或进入
Host 队列；持久事件使用每 epoch 递增且不复用的 `sequence`；附件只能通过受
校验的 opaque id 引用。

| Operation | Role | Behavior |
|---|---|---|
| `connection/initialize` | authenticated | 协商协议、能力、限制和策略 |
| `connection/ping` | authenticated | 返回连接健康和服务器时间 |
| `host/list` | authenticated | 列出主体可见的 Host，仅 Gateway 部署 |
| `project/list` | viewer | 列出主体可在其下创建会话的项目 |
| `session/list` | viewer | 列出主体可见会话 |
| `session/get` | viewer | 返回会话元数据和状态 |
| `session/create` | controller | 在授权项目 id 下创建会话 |
| `session/attach` | viewer | 建立会话角色并返回快照 |
| `session/history` | viewer | 从某个 item id 向前分页已完成条目 |
| `events/subscribe` | viewer | 按游标订阅会话流或 Host 流 |
| `events/unsubscribe` | viewer | 移除订阅 |
| `events/ack` | viewer | 确认已应用的最高持久序号 |
| `turn/start` | controller | 立即准入或进入 Host 队列并返回 `turnId` |
| `turn/get` | viewer | 返回回合状态 |
| `turn/stop` | controller | 在当前助手/工具边界后结束回合，幂等 |
| `turn/interrupt` | controller | 立即中止回合，对排队回合等同取消，幂等 |
| `turn/cancel` | controller | 移除尚未开始的排队回合，幂等 |
| `turn/prioritize` | controller | 把排队回合移到会话队列头部，幂等 |
| `approval/respond` | approver | 解决活动审批请求 |
| `input/respond` | controller | 解决活动输入请求 |
| `attachment/create` | controller | 预留有界附件槽位 |
| `attachment/complete` | controller | 校验附件 hash 和大小 |
| `tools/advertise` | owner | 公布在客户端执行的会话工具；替换该连接此前的集合；断开即清除 |
| `session/revoke` | owner | 撤销客户端或会话成员资格 |
| `session/archive` | owner | 归档空闲会话 |

远端 Host profile（v1.1，rollout R2 必需）：当桌面是另一台机器上 `pi-host` 的
客户端时，renderer 期望本地拥有的会话控制。这些操作从 v1.1 起属于契约，通过
`remoteHostProfile` 能力公布，各自保持本地规则：配置与 fork 仅限空闲，删除仅限
owner，工作区读取都按会话持久根、Host 忽略规则和 `PATH_OUTSIDE_WORKSPACE` 边界解析。

| Operation | Role | Behavior |
|---|---|---|
| `session/configure` | controller | 空闲时修改模式、provider/模型、思考等级或权限模式，规则同 `pi-desktop/session/configure` |
| `session/fork` | controller | 将空闲会话（可指定消息 id）fork 为新的空闲会话 |
| `session/rename` | controller | 重命名会话 |
| `session/delete` | owner | 删除会话及其在 Host 上的 transcript |
| `session/compact` | controller | 对活动会话执行手动上下文检查点 |
| `workspace/list` | viewer | 有界列出会话根下的条目，遵守 Host 忽略规则 |
| `workspace/read` | viewer | 读取会话根下的一个有界文件，图片以 data URL 返回 |
| `workspace/diff` | viewer | 返回会话根的工作树 diff |
| `terminal/open` | owner | 在 Host 上以会话根为 cwd 打开 pty，或连接已有终端；返回终端 id、尺寸和有界输出回放环 |
| `terminal/input` | owner | 向当前连接已连接的终端写入最多 64 KiB 的规范 Base64 UTF-8 字节 |
| `terminal/resize` | owner | 调整当前连接已连接的终端尺寸 |
| `terminal/close` | owner | 关闭当前连接已连接的终端；已关闭终端对其所属主体重复关闭时幂等 |
| `connection/pair` | authenticated | 用升级请求携带的一次性配对令牌换取设备凭证（安全规格 §3.4）；仅在配对连接上有效（D448） |
| `project/register` | owner | 将 Host 上的目录注册为项目：Host 规范化并校验路径，返回项目 id（D448） |
| `project/browse` | owner | 列出 Host 某路径下的目录，有界，供远程目录选择器使用（D448） |

### 远程终端的所有权与恢复

首期远程 Host 的终端操作仅限 `owner`。当前 SSH 部署还要求调用方是已配对的
owner 设备。Host 未提供终端实现时会公布 `terminal: false` 并拒绝终端请求。

创建终端时，`terminal/open` 不带 `terminalId`。客户端可以为这次逻辑打开请求附带稳定的
`openRequestId`。Host 按主体和会话限定该 id；只要幂等记录仍保留，使用相同值重试且原终端
仍打开时，Host 会重新连接并返回原终端，不会再创建一个 pty。Host 将该记录保存在有界的
内存映射中；Host 重启后记录丢失，也不能据此重新打开已关闭的终端。客户端已有
`terminalId` 时，用该 id 调用 `terminal/open` 以连接已有终端。连接时必须同时匹配请求中的会话和终端所属主体，否则
返回 `NOT_FOUND`。

一个打开的终端同一时刻只有一个活动连接。`terminal/input`、`terminal/resize` 和
`terminal/close` 必须操作当前 RACP 连接已连接的终端。连接断开时，Host 仅解除该连接
拥有的终端；解除连接会清除事件接收器，但保留 pty。相同主体可在新连接上重新连接并接管
输出流。返回的有界回放环只包含终端输出；之后的新输出通过 `terminal.output` 流式发送。
连接断开后，客户端不得重放或自动重试 `terminal/input`，因为响应丢失前输入可能已经到达
shell。

`terminal/input.data` 必须是包含有效 UTF-8 字节的规范填充标准 Base64。每个请求解码后最多
64 KiB；空值是有效的空操作。在该上限对应的最大编码长度以内，Base64 格式不规范或 UTF-8
无效时返回 `INVALID_ARGUMENT`。超过最大编码长度的值会在解码前以 `PAYLOAD_TOO_LARGE` 拒绝；
其他解码后超过 64 KiB 的输入也返回 `PAYLOAD_TOO_LARGE`。错误包含 `details.limitBytes`；
能够从规范编码精确计算长度时还会返回 `details.actualBytes`。

终端仍打开时，`terminal/close` 也要求当前连接已连接该终端。终端已经关闭后，仅其所属
主体重复关闭才作为空操作成功。`terminal.changed` 和 `terminal.output` 都是连接内通知，
不写入会话持久事件日志。`terminal.changed` 携带当前会话序号但不分配新序号；
`terminal.output` 使用 `afterSequence` 标记位置，只能通过终端回放环恢复。

仍推迟的本地操作：

| Reserved operation | Local equivalent | Why deferred |
|---|---|---|
| 逐回合模型或思考等级覆盖 | composer 下一回合配置 | `session/configure` 覆盖空闲情形；逐回合覆盖需单独策略评审 |
| provider、secret 和 vendor 账号管理 | settings 与 secrets IPC | 明确超出范围；远端 Host 的 provider 经 SSH 引导通道配置 |

## 4. 游标、队列、审批和附件

客户端重连时发送 `after: { epoch, sequence }`。游标仍在当前 epoch 的窗口内
则只回放持久事件，epoch 变化或游标被驱逐则返回 `resync.required` 和完整快照，
不能猜测丢失事件。首个实现把持久日志放在 Host 进程内存，Host 重启即开启新
epoch；把日志放入 host-core 需要单独的 ADR。

`turn/start` 默认 `reject_if_busy`，忙时返回 `AGENT_BUSY`；`admission: "queue"`
进入 Host 拥有的每会话队列，所有客户端（含本地桌面）看到同一份队列；`turn/prioritize` 把排队回合移到队列头部
（桌面的“立即发送”），不触碰正在运行的回合，想让它在下一个边界启动的客户端再调用
`turn/stop`。排队回合及其
幂等 key 由 host-core 持久化（D375），Host 重启后按序恢复并保持挂起，直到有
controller 接入才继续释放，重启绝不无人值守地启动工作。远程主体
发起的回合运行在会话权限模式与 Host `remoteMaxPermissionMode`（默认 `ask`）
中较低者之下，结果以 `effectivePermissionMode` 报告，不改变持久会话模式。经 SSH
配对的桌面设备默认豁免上限，Host 策略 `applyCeilingToPairedDevices` 可重新施加。

反向工具中继：`owner` 可用 `tools/advertise` 替换该连接在某个会话的工具目录；断开时
Host 清除该连接的所有公布。Host 只接受 `plugin_` 或 `mcp_` 名称、明确声明
`workspaceFree: true` 的工具，以及有界的对象 JSON Schema；Host 不根据名称推断工作区安全性。
每个会话目录最多 64 个工具和 512 KiB 描述符；名称最多 160 字符、描述最多 4 KiB、
schema 最多 64 KiB，深度最多 16、节点最多 4,096，超时为 100 ms 至 120 秒，参数和结果
各最多 256 KiB。拒绝重复名称和包含 `$ref`、`$dynamicRef` 或 `$recursiveRef` 的 schema。

回合启动时 Host 固定当时的目录快照，只把这些已公布工具交给 Agent；目录中的每项都绑定
原公布连接和 revision。若公布被替换或连接断开，该快照条目立即失效；Host 不会按相同名称
改路由到另一连接。名称冲突的工具不会进入 Agent 目录。Agent 调用时 Host 先执行正常权限
检查，再向该原连接发 `tool/execute`，使用广告中的超时；未公布工具、会话/回合不匹配、
超时、断开、无效响应或客户端错误均以 `TOOL_FAILED` 结束该工具调用，并允许回合继续，
不会跨连接重试。核心、系统和工作区工具不经过中继；客户端不得提供风险或 Plan 安全元数据，
中继插件工具在没有 Host 验证的 Plan 安全元数据时不适用于 Plan/Goal。

`workspaceFree: true` 是 owner 对工具来源的声明，不是 Host 独立验证来源的证明；Host 只校验
该字段为字面量 `true`、角色/能力、schema 和有界限制，并执行 Host 权限策略。桌面必须从可信的
来源注册信息推导此声明；来源元数据缺失或不确定时必须拒绝公布。初版桌面适配器只能公布
`toolsForProject(null)` 返回的全局 User MCP 工具；在可信插件分类器和产品决定完成前不公布插件工具。
目前 Host/RACP 契约测试覆盖中继路径；桌面 global User MCP 适配器已实现，尚待审查与验证，
Linux SSH 全流程 harness 仍未具备，因此 E2E-231 仍为草稿。

```json
{"jsonrpc":"2.0","id":"server-request-77","method":"tool/execute","params":{"executionId":"exec_01J","toolName":"mcp_corp_search"}}
```

审批决策是本地词汇的超集：工具审批为 `allow-once`、`allow-session`、`deny`；
Plan/Goal 审批为带显式 `permissionMode` 的 `approve` 或 `reject`，且是跨回合的
会话级转换；asktool 回答为 `Array<string[] | null>`，`null` 表示跳过。待处理请求
是 Host 状态，host-core 通过 `permissions.pending` 提供读取，晚接入的客户端在
快照中看到它们；首个有效决定生效，之后的有效响应返回 `alreadyResolved`。审批
寿命由 Host 策略决定：本地默认 120 秒后拒绝，有远程订阅者接入时默认 30 分钟
（D375），Host 可在上限内调整，本地或远程任一决定先到即生效，断线不会延长它。

大附件使用 `attachment/create`、HTTPS 上传和 `attachment/complete`；
远程本地路径、`file://` 和任意 URL 都不允许作为附件来源。经 Gateway 时上传
目标由 Gateway 提供，字节以有界分块经 Host link 到达 Host，Gateway 在
`attachment/complete` 成功或过期后删除副本。

## 5. 传输映射

| Operation family | HTTP mapping |
|---|---|
| Capabilities | `GET /v1/capabilities` |
| List hosts (Gateway only) | `GET /v1/hosts` |
| List projects | `GET /v1/projects` |
| List sessions | `GET /v1/sessions` |
| Create session | `POST /v1/sessions` |
| Get/attach session | `GET /v1/sessions/{sessionId}` / `POST ...:attach` |
| Session history | `GET /v1/sessions/{sessionId}/history` |
| Start turn | `POST /v1/sessions/{sessionId}/turns` |
| Get turn | `GET /v1/turns/{turnId}` |
| Stop / interrupt / cancel turn | `POST /v1/turns/{turnId}:stop` / `:interrupt` / `:cancel` |
| Prioritize turn | `POST /v1/turns/{turnId}:prioritize` |
| Session event stream | `GET /v1/sessions/{sessionId}/events` |
| Host event stream | `GET /v1/events` |
| Resolve approval | `POST /v1/approvals/{approvalId}:respond` |
| Resolve input | `POST /v1/inputs/{inputId}:respond` |

`RACP-WS` 是 v1 唯一规范绑定，首个部署（rollout R2）是远端机器上只绑定 loopback
的 `pi-host`，桌面经 SSH 端口转发以 header profile 和 SSH 引导配对得到的设备 token
连接，绑定与对端都是 loopback 时才接受明文 `ws://`；`RACP-HTTP` 是浏览器 profile，
在任何浏览器客户端发布前必须交付，但浏览器里程碑不排期（D375），映射保留以免
契约漂移；`RACP-GRPC` 保留，若采用则 `.proto` 由 typebox 来源生成。Host link 属于
不排期的 Gateway 里程碑，SSH 隧道拓扑不使用它。浏览器
无法在 WebSocket/EventSource 上设置请求头，因此非浏览器客户端用
`Authorization` 头（header profile），浏览器客户端用 HttpOnly cookie + Origin 白名单
+ CSRF token（cookie profile）；两者都禁止 URL 中的 token。Host link
（`racp-hostlink.v1`）在一条出站连接上复用逻辑客户端连接，服务端发起的请求按
`clientConnectionId` 中继并在同一逻辑连接上应答；Gateway 不得改写其中的消息。

## 6. 限制和错误

| Limit | Target |
|---|---:|
| JSON request or event frame | 1 MiB |
| Prompt payload | 256 KiB |
| Attachment | 50 MiB |
| Host link attachment chunk | 256 KiB |
| Durable session event replay | 10,000 events or 24 hours |
| Ephemeral events | 不保留 |
| Queued turns per session | 8 |
| Concurrent subscriptions per connection | 8 |
| Connected clients per Agent Host | 16 |
| `connection/initialize` deadline | 10 seconds |
| Read/metadata operation deadline | 15 seconds |
| `turn/start` admission deadline | 5 seconds |
| Approval lifetime, local default | 120 秒后拒绝 |
| Approval lifetime, remote policy | 有远程订阅者接入时默认 30 分钟；Host 配置、有界，以 `approvalLifetimeMs` 公布 |
| Heartbeat interval | 30 seconds |
| Terminal output replay ring | 每终端 128 KiB |
| Open terminals per session | 2 |
| Relayed tool execution deadline | 工具自身超时 |

| Code | Retriable | Meaning |
|---|---:|---|
| `UNAUTHORIZED` | no | 凭据缺失、过期或无效 |
| `FORBIDDEN` | no | 主体没有操作或会话范围 |
| `PROTOCOL_MISMATCH` | no | 协议主版本或能力不支持 |
| `INVALID_ARGUMENT` | no | 请求结构或字段无效 |
| `NOT_FOUND` | no | Host、项目、会话、回合、审批、输入或附件不存在 |
| `AGENT_UNAVAILABLE` | yes | Host 或 runtime 离线 |
| `AGENT_BUSY` | no | 请求的准入模式下不能接受回合，或队列已满 |
| `CONFLICT` | yes | revision 过期或回合已不在所需状态 |
| `IDEMPOTENCY_CONFLICT` | no | 同一 key 使用了不同输入 |
| `CURSOR_EXPIRED` | no | epoch 已变化或游标不在回放窗口内 |
| `CLIENT_TOO_SLOW` | yes | 有界事件队列溢出 |
| `APPROVAL_EXPIRED` | no | 审批已不可执行；映射自 `PERMISSION_TIMEOUT` 与 `PLAN_APPROVAL_TIMEOUT` |
| `APPROVAL_STALE` | no | 审批响应针对旧 revision |
| `PAYLOAD_TOO_LARGE` | no | 请求、事件或附件超限 |
| `RATE_LIMITED` | yes | 主体、会话或 Host 超额 |
| `PAIRING_FAILED` | no | 配对令牌未知或已被兑换 |
| `PAIRING_TOKEN_EXPIRED` | no | 配对令牌的引导窗口已过 |
| `CAPABILITY_UNAVAILABLE` | no | Host 未宣告该操作所需的能力 |
| `REMOTE_PATH_NOT_FOUND` | no | Host 侧路径不存在 |
| `REMOTE_PATH_FORBIDDEN` | no | Host 侧路径超出主体可达范围 |
| `INTERNAL` | maybe | 带 trace id 的内部错误 |

错误必须同时携带稳定 code、可重试标记和 trace id。重复 mutation 使用同一
idempotency key 时返回原结果；使用相同 key 发送不同输入则失败。

## 7. 兼容性与修订

新增字段只能追加，不能复用已有字段含义。可选能力必须通过初始化协商。
终止状态不能回到活动状态；每个已发布 binding 的行为都必须通过相同 fixture
验证，`RACP-WS` 是参考绑定。D374 于 2026-09-10 修订了 D373 草案：补齐本地
审批词汇、引入 epoch 与瞬态事件、加入 Host 队列与 `permissions.pending`、
新增 `host/list`、`project/list`、`session/history`、`turn/stop`、`turn/cancel`
和 Host 流订阅、收敛为单一规范绑定与单一 IDL、定义浏览器认证 profile、Host link
中继、远程权限上限和远程审批寿命。D375 又加入远端 Host profile、`RACP-WS` 的
SSH 隧道部署与 loopback 规则、SSH 配对 owner 设备的上限豁免，并把 `RACP-HTTP`、
cookie profile 与 Host link 标记为不排期；终端流式操作、`tools/advertise` 与
`tool/execute` 中继、host-core 持久化的队列、远程订阅者 30 分钟默认审批寿命和
`applyCeilingToPairedDevices` 策略同属该修订。
完整状态机、示例和验收条款见英文源规格。
