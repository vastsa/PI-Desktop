# 远程 Agent 控制目标架构

- 状态：目标规格，属于 MVP 之后
- 决策：D373 / ADR 0205，经 D376 修订
- 英文源规格：[英文源规格](/spec/02-architecture/05-remote-agent-control)

本页是英文规范的中文导读。远程控制当前仍不属于 MVP，不会把现有
Electron IPC、`host.proxy` 或 Rust host-core 暴露到网络。

## 1. 范围与原则

目标是让经过认证的远程客户端查看和控制 Agent Host，同时保持会话、
回合、回合队列、事件游标、审批、附件、工作区和权限都由 Host 掌权。

- 客户端可以断开，Agent 回合仍继续。
- 重连使用快照或 `{ epoch, sequence }` 游标回放，不依赖时间戳。
- `RACP-WS` 是 v1 唯一规范绑定；`RACP-HTTP` 是同一契约的浏览器 profile；
  `RACP-GRPC` 保留，不进入 v1 一致性范围。
- Host 是无头模块：会话与回合准入、回合队列、审批代理、事件日志和快照
  构建都不依赖 Electron，桌面 IPC、本地 MCP 和 RACP 是它的三个调用方。
- 本地 stdio NDJSON JSON-RPC、Rust host-core 和 loopback MCP 保持不变。

## 2. 参考实现

设计参考 OpenAI Codex App Server、VS Code Agent Host、MCP Transport 和
Google A2A 的分层方式，但不恢复已撤回的子代理 A2A/Peer 协调通道。

## 3. 组件职责

| 组件 | 职责 | 不得拥有 |
|---|---|---|
| Remote Client | 展示状态、发送用户意图、回答审批和输入 | 工作区权限、provider 凭据、最终权限决定、prompt 队列 |
| Agent Host | 拥有会话、回合、每会话回合队列、事件游标、附件、工具执行和生命周期 | 浏览器展示状态 |
| 无头 Agent Host 模块（`packages/agent-host`） | 会话/回合准入、回合队列、审批代理、内存事件日志、快照构建；向桌面 IPC、本地 MCP 和 RACP 暴露同一套 API | Electron、renderer 或传输依赖；第二套权限或持久化实现 |
| Gateway | 身份认证、路由、Host link、限流、审计、上传字节的瞬态缓冲、（保留）推送脱敏摘要 | provider secret、完整 transcript、host-core 访问、上传窗口之外的附件字节 |
| Node pi sidecar | 运行 pi Agent 和 provider stream | 远程认证、工作区策略、secret storage |
| Rust host-core | SQLite、工具、工作区、权限及待处理权限表、secret 和本地持久化 | 公网监听器 |

## 4. 部署拓扑

### 4.1 当前本地桌面

```text
PI-Desktop
├── Electron Main
│   ├── Renderer
│   ├── Node pi sidecar
│   └── Rust host-core
└── optional loopback MCP
```

### 4.2 开发或可信 LAN

```text
Remote Client ── WSS / SSH tunnel ── Agent Host
                                      ├── pi sidecar
                                      └── Rust host-core
```

### 4.3 生产 Gateway

```text
Client ── HTTPS/WSS ── Gateway
                         │ outbound WSS Host link (relay)
                         ▼
                      Agent Host ── pi + Rust host-core
```

生产模式由 Agent Host 主动建立出站 Host link，Gateway 不要求桌面开放入站
端口。Host link 是中继 profile：它复用多个逻辑客户端连接，让服务端发起的
审批请求到达正确的客户端，让附件字节无需入站端口即可到达 Host。

## 5. 角色、队列与事件同步

每个会话允许多个 viewer，但同一时间只允许一个活动回合。controller
可以启动、排队、停止或中断回合并回答输入请求，approver 只能在授权范围内
解决审批，owner 管理成员。排队中的回合是 Host 状态，本地桌面和所有远程
客户端看到同一份队列。远程主体发起的回合受 Host 的远程权限上限约束。

Host 为每个会话生成 `epoch`，并在其中为持久事件分配严格递增的
`sequence`。delta、工具进度和活动阶段是瞬态事件，只带 `afterSequence`，
不进入回放窗口；快照的 `activeItems` 携带它们累计的内容。客户端先取得
快照，再按游标接收事件；游标失效时必须应用完整快照，不能猜测中间状态。
首个实现把持久日志放在 Host 进程内存，Host 重启即开启新 epoch。

```text
cursor in current epoch and retained -> replay durable sequence > after
epoch changed or cursor evicted      -> resync.required + snapshot
cursor ahead                         -> reject and refresh snapshot
```

```text
Client -> initialize / attach / subscribe
Client -> turn/start (admission)
Host   -> turn.queued | turn.started, ordered events
Host   -> approval/request or input/request when required
Client -> approval/respond | input/respond
Host   -> turn terminal event, next queued turn starts
```

远程审批使用与桌面相同的决策词汇：工具审批为 `allow-once`、
`allow-session`、`deny`；Plan/Goal 审批为带显式权限模式的 `approve` 或
`reject`；asktool 输入支持逐题回答或跳过。审批寿命由 Host 策略决定：本地默认
仍是 120 秒后拒绝，启用远程控制的 Host 可为远程订阅者配置更长的有界寿命。

## 6. 传输档案

| Profile | Intended client | Direction | Status |
|---|---|---|---|
| Local stdio JSON-RPC | Electron Main / sidecars | Full duplex | Existing |
| RACP-WS | Native、Electron、cookie profile 的浏览器 | Full duplex | v1 规范绑定 |
| RACP-HTTP | Browser、simple integrations | Commands + server stream | 浏览器 profile |
| RACP-GRPC | Native service | Unary + server stream | 保留，不在 v1 |
| Host link `racp-hostlink.v1` | Gateway → Host | Multiplexed full duplex | 基于 RACP-WS 帧的中继 profile |

## 7. 故障与迁移

| Failure | Required behavior |
|---|---|
| Client disconnect | 回合继续，保留持久事件回放窗口 |
| Client reconnect | 重新认证，按游标回放或返回快照 |
| Gateway disconnect | Host 有界退避重连 Host link，本地回合继续 |
| Host unavailable | 拒绝新的 mutation，不自动重放 |
| Host restart | 新 epoch，客户端从快照重同步，队列清空且不重放 |
| Host crash | 使用现有恢复策略，已中断工作不自动重放 |
| Duplicate mutation | 相同主体和 key 返回原 idempotent 结果 |
| Durable event gap | 停止应用并请求快照 |
| Slow client | 先丢弃瞬态事件，丢失持久事件前带游标断开 |
| Expired approval | 返回 `APPROVAL_EXPIRED`，不执行工具 |

首个实现交付无头 `packages/agent-host` 模块，Electron Main 承载它，现有 IPC
handler 成为它的适配层；随之落地 host-core 的 `permissions.pending` 读取和用
Host 队列替换 renderer 内存队列。独立 Host 的抽取只是搬移模块，不改变线上契约。

## 8. 验收要点

远程客户端不能取得 host-core、IPC、`host.proxy` 或 provider secret；回合
断线后仍可继续；晚接入的客户端能看到已打开的审批；远程回合不超过权限
上限；回放、审批、幂等和所有已发布绑定的一致性测试必须通过；无头模块的
测试不依赖 Electron。

详见英文源规格中的完整组件归属、迁移边界和验收条款。
