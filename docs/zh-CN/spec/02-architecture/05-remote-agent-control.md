# 远程 Agent 控制目标架构

- 状态：目标规格，属于 MVP 之后
- 决策：D373 / ADR 0205，经 D374 与 D375 修订
- 英文源规格：[英文源规格](/spec/02-architecture/05-remote-agent-control)

本页是英文规范的中文导读。远程控制当前仍不属于 MVP，不会把现有
Electron IPC、`host.proxy` 或 Rust host-core 暴露到网络。

## 1. 范围、顺序与原则

目标是让经过认证的远程客户端查看和控制 Agent Host，同时保持会话、
回合、回合队列、事件游标、审批、附件、工作区和权限都由 Host 掌权。

D375 固定了拓扑的交付顺序：首个远程部署是桌面本身作为远端无头 Host 的
客户端，经 SSH 隧道连接（#176、#140）；第二个是 Host 旁的出站消息集成
（#100）。Gateway 路由与浏览器访问保留完整规格，但在有需求信号或产品决策
之前不排期。

- 客户端可以断开，Agent 回合仍继续。
- 重连使用快照或 `{ epoch, sequence }` 游标回放，不依赖时间戳。
- `RACP-WS` 是 v1 唯一规范绑定，首先部署在 SSH 隧道上；`RACP-HTTP` 是
  浏览器 profile，不排期；`RACP-GRPC` 保留。
- Host 是无头模块：会话与回合准入、回合队列、审批代理、事件日志和快照
  构建都不依赖 Electron，桌面 IPC、本地 MCP、RACP 和消息集成都是它的调用方。
- 远程会话完全存在于其 Host 上：transcript、工具、工作区、权限和 provider
  secret 都在运行 Host 的机器上，桌面只展示和控制。
- 用户本地化是结构性的：控制链路中没有任何项目方运营的服务，所有凭据由用户
  自己的 Host 签发，出站连接只有用户的 SSH 主机、用户配置的消息渠道与模型
  provider，以及只读的 GitHub Releases `pi-host` 下载（D385）。
- 本地 stdio NDJSON JSON-RPC、Rust host-core 和 loopback MCP 保持不变。

## 2. 参考实现

设计参考 OpenAI Codex App Server、VS Code Agent Host、MCP Transport 和
Google A2A 的分层方式；SSH 隧道拓扑沿用 VS Code Remote-SSH 与 JetBrains
Gateway 的模式，服务端经用户自己的 SSH 会话引导，客户端通过转发的 loopback
端口连接。不恢复已撤回的子代理 A2A/Peer 协调通道。

## 3. 组件职责

| 组件 | 职责 | 不得拥有 |
|---|---|---|
| Remote Client | 展示状态、发送用户意图、回答审批和输入 | 工作区权限、provider 凭据、最终权限决定、prompt 队列 |
| 桌面 RACP 客户端适配层（Electron Main） | 通过现有 `lib/api.ts` 表面把远端 Host 呈现给 renderer；负责 SSH 引导、配对和端口转发 | 第二份 transcript 存储；在本地执行远端工具 |
| Agent Host | 拥有会话、回合、每会话回合队列、事件游标、附件、工具执行和生命周期 | 浏览器展示状态 |
| 无头 Agent Host 模块（`packages/agent-host`） | 会话/回合准入、回合队列、审批代理、内存事件日志、快照构建；向桌面 IPC、本地 MCP、RACP 和集成暴露同一套 API | Electron、renderer 或传输依赖；第二套权限或持久化实现 |
| `pi-host` 无头包 | 在远端机器上以桌面同版本运行模块、Node pi sidecar 和 Rust host-core，只绑定 loopback，由引导脚本从 GitHub Releases 下载 | 桌面 UI、插件面板、其他 Host 的 secret |
| 消息集成适配层 | 在 Host 进程内订阅 Host 范围事件，把脱敏摘要转发到出站渠道；把固定指令词汇映射到回合与审批操作 | 自己的权限策略、入站监听器、原始 transcript 内容 |
| 自托管 Gateway（不排期） | 以 Host 签发的设备凭据准入、路由、Host link、限流、审计、上传字节的瞬态缓冲、（保留）推送脱敏摘要 | provider secret、完整 transcript、host-core 访问、上传窗口之外的附件字节 |
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

### 4.2 SSH 隧道上的远端 Host（首个远程拓扑）

```text
PI-Desktop (Remote Client)              Remote machine
├── Renderer ── lib/api.ts ─┐           ┌── pi-host (headless Agent Host)
├── Electron Main           │ RACP-WS   │   ├── packages/agent-host
│   └── RACP client adapter ┼─ over SSH ┼──▶│   ├── Node pi sidecar
└── local sessions          │ forward   │   │   └── Rust host-core (loopback)
    (unchanged)             │           │   └── workspace, ~/.agents, secrets
                            │           └── sshd
```

引导只走用户自己的 SSH 会话，不走 RACP：桌面用现有 SSH 配置登录，上传一段引导脚本，由它从
GitHub Releases 下载与桌面同版本的 `pi-host` 包并校验公布的 SHA-256，启动它并绑定 loopback，经 SSH 通道拿到一次性
配对 token，转发本地端口后以 header profile 连接 `RACP-WS`，用配对 token 换取
设备 token 存入桌面安全存储；Host 把该桌面设备记为 `owner`。远端 Host 的
provider 配置由引导步骤经 SSH 通道写入，是 Host 本地配置，绝不经过 RACP。
Host 只绑定 loopback；只有绑定地址与对端地址都是 loopback且出示有效设备 token
时才接受明文 `ws://`，因为 SSH 通道已提供机密性，SSH 登录也已证明对该机器的
shell 访问。非 loopback 绑定仍要求 TLS 与设备 token。首版无法引导没有 GitHub 出网能力的机器。

### 4.3 自托管 Gateway（不排期）

```text
Client ── HTTPS/WSS ── Gateway
                         │ outbound WSS Host link (relay)
                         ▼
                      Agent Host ── pi + Rust host-core
```

生产模式由 Agent Host 主动建立出站 Host link，Gateway 不要求桌面开放入站
端口。Host link 是中继 profile，复用多个逻辑客户端连接。PI 不运营 Gateway：若日后
排期，由用户在自己的基础设施上运行，并以 Host 签发的设备凭据准入（D385）。本拓扑
保留规格以免契约漂移，但不排期。

## 5. 角色、队列、归属与事件同步

每个会话允许多个 viewer，但同一时间只允许一个活动回合。controller
可以启动、排队、停止或中断回合并回答输入请求，approver 只能在授权范围内
解决审批，owner 管理成员。排队中的回合是 Host 状态，由 host-core 持久化，重启后恢复并保持挂起直到有
controller 接入，本地桌面和所有远程客户端看到同一份队列。经 Gateway 路由的主体受远程权限上限约束；经 SSH 引导
配对的桌面设备持有 `owner` 并豁免上限，因为 SSH 访问已经超过上限能限制的一切；
Host 策略 `applyCeilingToPairedDevices`（默认关闭）可重新施加。

远程会话的归属划分：远端 Host 拥有 transcript 与 SQLite、回合与队列、内置工具
目录与工作区边界、权限与会话授权、provider secret、该机器 `~/.agents` 下的
skills 与子代理定义、该 Host 配置的 MCP 服务器和定时任务；桌面保留窗口与
shell、本地会话、本地应用的设置 UI、插件面板、浏览器预览和通知展示。桌面通过
`tools/advertise` 公布其用户配置的 MCP 服务器和不需要会话工作区的插件工具，它们
以中继工具身份出现在远程会话目录中，经 `tool/execute` 服务端请求在桌面自身的插件
权限下执行；需要工作区或文件系统访问的插件工具被排除，因为它们会作用于桌面的
文件系统。工作面板的文件列表、文件读取和 diff 使用远端 Host profile 操作；终端
通过 `terminal/*` 操作在远端机器运行并带有界回放环；浏览器预览留在本地。

Host 为每个会话生成 `epoch`，并在其中为持久事件分配严格递增的
`sequence`。delta、工具进度和活动阶段是瞬态事件，只带 `afterSequence`，
不进入回放窗口；快照的 `activeItems` 携带它们累计的内容。首个实现把持久
日志放在 Host 进程内存，Host 重启即开启新 epoch。

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
`reject`；asktool 输入支持逐题回答或跳过。修改持久模式使用远端 Host profile
的 `session/configure`，与本地一样仅限空闲时。审批寿命由 Host 策略决定：本地
默认仍是 120 秒后拒绝，有远程订阅者接入时默认 30 分钟（D375），有界且可由运维调整。

## 6. 传输档案

| Profile | Intended client | Direction | Status |
|---|---|---|---|
| Local stdio JSON-RPC | Electron Main / sidecars | Full duplex | Existing |
| RACP-WS | 经 SSH 的桌面客户端、Native、Electron | Full duplex | v1 规范绑定，首先部署在 SSH 隧道上 |
| RACP-HTTP | Browser、simple integrations | Commands + server stream | 浏览器 profile，不排期 |
| RACP-GRPC | Native service | Unary + server stream | 保留，不在 v1 |
| Host link `racp-hostlink.v1` | Gateway → Host | Multiplexed full duplex | 基于 RACP-WS 帧的中继 profile，随 Gateway 不排期 |

## 7. 故障与迁移

| Failure | Required behavior |
|---|---|
| Client disconnect | 回合继续，保留持久事件回放窗口 |
| Client reconnect | 重新认证，按游标回放或返回快照 |
| SSH tunnel drop | 桌面适配层重建转发并按游标恢复，远端回合继续 |
| Gateway disconnect | Host 有界退避重连 Host link，本地回合继续 |
| Host unavailable | 拒绝新的 mutation，不自动重放 |
| Host restart | 新 epoch，客户端从快照重同步，持久化的队列按序恢复并挂起到 controller 接入，已开始的工作不重放 |
| Host crash | 使用现有恢复策略，已中断工作不自动重放 |
| Duplicate mutation | 相同主体和 key 返回原 idempotent 结果 |
| Durable event gap | 停止应用并请求快照 |
| Slow client | 先丢弃瞬态事件，丢失持久事件前带游标断开 |
| Expired approval | 返回 `APPROVAL_EXPIRED`，不执行工具 |

首个实现交付无头 `packages/agent-host` 模块，Electron Main 承载它，现有 IPC
handler 成为它的适配层；随之落地 host-core 的 `permissions.pending` 读取和用
host-core 持久化的 Host 队列替换 renderer 内存队列（需单独 ADR 与 schema 升级，
D375）。SSH 隧道里程碑再加两件东西而不改线上契约：`pi-host` 包，以及位于
`lib/api.ts` 之下的桌面 RACP 客户端适配层；同一里程碑还包含 `tools/advertise` /
`tool/execute` 中继与 `terminal/*` 操作。消息集成是
模块在 Host 进程内的又一个调用方，不需要任何传输。

## 8. 验收要点

远程客户端不能取得 host-core、IPC、`host.proxy` 或 provider secret；回合
断线后仍可继续；晚接入的客户端能看到已打开的审批；经 Gateway 的回合不超过
权限上限；远程会话的 transcript、工具、工作区和 secret 都在远端 Host，桌面
只保留展示状态；远程会话的目录包含远端 Host 的工具与桌面公布的中继工具，中继
工具只在桌面执行；会话终端在远端机器的会话根内运行且只对策略允许的主体开放；回放、审批、幂等和
所有已发布绑定的一致性测试必须通过；无头模块的测试不依赖 Electron。

详见英文源规格中的完整组件归属、迁移边界和验收条款。
