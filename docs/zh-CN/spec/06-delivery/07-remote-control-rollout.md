# 远程 Agent 控制交付与验收

- 状态：目标交付规格，属于 MVP 之后
- 决策：D373 / ADR 0205，经 D374 与 D375 修订
- 英文源规格：[英文源规格](/spec/06-delivery/07-remote-control-rollout)

## 1. 交付边界与顺序

当前 MVP 仍然只提供本地 Electron Main、pi sidecar、Rust host-core、
loopback MCP；不得直接暴露 host-core 或现有 IPC。远程工作先从 typebox
契约、无头 Agent Host 模块、fixture 和状态机测试开始，再在显式 feature flag
之后加入传输绑定。

D375 按已记录的需求而不是传输广度排序：#176 与 #140 要从本地桌面操作远程
Linux 或 WSL 机器上的项目，即 SSH 隧道远端 Host 拓扑；#100 要把任务完成与
审批通知推送到 Telegram、微信、Slack 或 Webhook 并回传简单指令，即 Host 旁的
出站集成；没有任何已记录的请求要求浏览器或手机端控制桌面，因此 Gateway 与
浏览器里程碑不排期。排期顺序为 R0、R1、R2、R3；不排期的里程碑保留规格以免
契约漂移，只由后续产品决策排期。

## 2. 里程碑

- R0：在 `packages/shared` 中以 typebox 定义 RACP v1 资源与操作（唯一契约来源，
  含远端 Host profile），生成 JSON Schema fixture，完成错误、游标、epoch、幂等、
  回合队列、审批（含 `allow-session` 与 Plan/Goal 权限模式选择）、远程权限上限
  及其 SSH 配对豁免的测试向量。
- R1：交付无 Electron 依赖的 `packages/agent-host` 模块，拥有会话/回合准入、
  回合队列、审批代理、带 epoch 的内存事件日志和快照构建；Electron Main 承载它，
  现有 IPC handler 成为适配层。随之交付 host-core 的 `permissions.pending`
  读取，并用由 host-core 持久化的 Host 队列替换 renderer 内存 prompt 队列（需单独 ADR 与
  schema 升级，D375），重启后队列恢复并挂起到 controller 接入。仅提供开发环境的
  loopback RACP-WS 端点。抽取在在途版本发布后开始，`permissions.pending`、
  Host 队列和模块抽取各自独立提交，因为仓库存在并发会话，且 54 个测试按源码
  模式匹配 `electron/main/index.ts`，需要重新指向。
- R2：SSH 隧道上的远端 Host。交付 `pi-host` 包（模块、Node pi sidecar 与平台
  host-core 二进制，与桌面同版本，只绑定 loopback，由桌面经 SSH 上传的引导脚本从
  GitHub Releases 下载并校验公布的 SHA-256，再经该 SSH 会话启动并配对）；位于 `lib/api.ts` 之下的桌面 RACP 客户端适配层，使远程会话像本地
  一样渲染；转发端口上的 `RACP-WS` header profile，遵守安全规格的 loopback 规则
  与设备 token 配对；远端 Host profile 操作（`session/configure`、
  `session/fork`、`session/rename`、`session/delete`、`session/compact`、
  `workspace/list`、`workspace/read`、`workspace/diff`）；以及远程会话归属划分；反向工具中继（`tools/advertise` 与 `tool/execute` 服务端
  请求，让桌面 MCP 服务器和不需工作区的插件工具在远程会话中于桌面执行）；终端
  （`terminal/open`、`terminal/input`、`terminal/resize`、`terminal/close`、
  `terminal.output` 与有界回放环，在远端机器运行）。
- R3：出站消息集成（#100）。Host 进程内的又一个模块调用方，无传输、无入站
  监听：订阅 Host 范围与会话事件，把 `turn.completed`、`turn.failed`、
  `approval.requested`、`input.requested` 的脱敏摘要转发到出站渠道（先 Webhook，
  再经 Telegram、Slack 的出站轮询或 socket 模式；需要入站回调的渠道推迟）；把固定
  指令词汇从已关联的聊天映射到 `turn/start`、`turn/stop`、`turn/interrupt`、
  `approval/respond`，以关联主体的角色和同一 Host 策略执行，未关联聊天忽略并审计；
  投递失败有界重试，绝不阻塞回合。
- 不排期：Gateway 与 Host link（原 R3），PI 不运营 Gateway，用户自托管并以 Host 签发的设备凭据准入，没有 Host 之外的身份源（D385）；浏览器 profile
  （原 R4），Gateway-less 场景的 Host 自签 cookie 仍需补规格条款；保留的 gRPC
  绑定（原 R5）仅在有明确消费者时交付，`.proto` 由 typebox 来源生成。

R2 的设计决定（D375，2026-09-10 记录）：远端 Host 的 provider 配置经 SSH 引导通道
写入，不经 RACP；桌面用户 MCP 服务器与不需工作区的插件工具在本里程碑通过反向工具
中继进入远程会话，需要工作区或文件系统访问的插件工具排除；工作面板终端在本里程碑
以 `terminal/*` 操作交付，在远端机器运行；`pi-host` 由桌面经 SSH 上传的引导脚本按
平台从 GitHub Releases 下载桌面版本并校验公布的 SHA-256，版本不匹配即
`PROTOCOL_MISMATCH` 并提供重新下载，首版不支持没有 GitHub 出网能力的机器；SSH 配对
的桌面设备持有 `owner` 并豁免远程权限上限，除非启用 Host 策略
`applyCeilingToPairedDevices`；R2 作为一个里程碑整体交付，不拆分。

R1 退出条件包括模块测试不依赖 Electron、晚接入的客户端能在快照中看到已打开
的审批且其决定能关闭本地桌面卡片。R2 退出条件包括 E2E-231 通过、SSH 会话中断
恢复后按游标续传不重复回合、远程会话的模式/模型/思考等级变更与本地一致且仅限
空闲、远端工具目录不含需要工作区的桌面插件工具、公布中继的桌面 MCP 工具在远程回合
中于桌面执行且桌面中途关闭时工具失败而回合继续、远程会话终端在远端机器的会话根内
运行且 SSH 中断后从回放环续传、引导下载校验 checksum 并拒绝被篡改的包、版本不匹配
被拒并提供更新。R3 退出条件包括
E2E-232 通过、载荷只含摘要与 id、未关联聊天的指令无效、Host 无新监听器。

## 3. 实现规则

RACP 服务只调用无头 Agent Host 模块，模块再调用 renderer 使用的同一套
host 与 sidecar 路径；不从网络监听器调用 renderer、`host.proxy` 或 host-core；
`pi-host` 在另一台机器上运行模块与监督而不改 RACP。Host 拥有活动回合、回合
队列和事件游标，客户端、浏览器标签、Electron 窗口与 SSH 会话的生命周期都不
控制 Agent 执行，结束回合必须显式调用 `turn/stop` 或 `turn/interrupt`。队列
只存在于 Host。renderer 保持与传输无关：它只经 `lib/api.ts` 访问后端，桌面
适配层为远端 Host 实现同一表面，远端 Host profile 未覆盖的功能按能力协商隐藏
而不是打桩，renderer 除展示徽标外不知道会话是本地还是远程。回放测试记录初始
快照游标、命令与幂等 key、每个已应用的持久序号、断开点、回放请求和最终快照
哈希；瞬态事件不参与顺序断言，但必须能从快照的 activeItems 重建。每个已发布
绑定必须保持相同的准入/拒绝、授权范围与权限上限、幂等结果、持久事件顺序、
队列顺序、审批生命周期与决策词汇、附件校验和终止状态。

## 4. 验证

必须覆盖生成的 schema 校验、会话/回合/队列/审批/输入/附件状态机、幂等、
游标回放与 epoch 变化、含权限上限及其 SSH 配对豁免与 `allow-session` 策略的
角色矩阵、待处理请求读取与集成载荷的脱敏、已发布 binding 一致性；集成层面
覆盖 Electron Main 内的模块、Linux 测试机上经 SSH 端口转发的 `pi-host`（含引导、
配对、版本不匹配、重新配对）、不变的 renderer 经桌面适配层渲染远程会话、远程
回合运行中 SSH 会话中断与恢复、Host 重启（含排队回合，验证持久化队列恢复并挂起）、SSH 中断下的中继工具执行与终端
流式、引导下载的有效与篡改 checksum、针对 Webhook 接收端与
长轮询 bot fixture 的集成适配层，排期后再覆盖 Gateway 路由、cookie profile 下的
浏览器重连和 NAT 下的 Host link 中继。安全验证覆盖无效、过期、撤销、错误 Host
的设备 token，`pi-host` 上非 loopback 对端与无 TLS 的非 loopback 绑定，配对 token
复用与非 SSH 通道配对，错误角色/会话/Host/revision，含 `workspace/read` 越界的
SSRF 与路径攻击，超限与哈希不符的上传，试图选择 secret 或权限的注入请求，
未关联聊天与重放的集成指令，慢读者与连接耗尽，审计脱敏与保留，排期后再覆盖
Origin、CORS、CSRF、cookie 与 Gateway 中继。运营指标记录准入延迟与队列深度、
SSH 转发上的事件延迟与序号滞后、回放/重同步/epoch 变化次数、审批等待与过期、
Host 连接健康与引导时长与版本不匹配、认证与授权失败、集成投递延迟与重试、
瞬态/持久分别统计的事件丢弃数，以及活动 Host/会话/客户端数。

## 5. 发布与回滚

先发布 typebox 契约、生成的 fixture 和禁用代码路径；R1 只在开发 profile 启用；
SSH 隧道拓扑先对 allowlist 用户以 feature flag 启用再普遍开放；集成适配层作为
默认不配置任何渠道的可选设置启用；Gateway、浏览器与 gRPC 只由记录在案的产品
决策排期。kill switch 拒绝新的远程连接并取消远程主体提交的排队回合，不影响
本地桌面。回滚必须停止接受新的远程连接并停止集成适配层，远端 `pi-host` 进程
按用户选择保留或停止但绝不删除其 transcript，保持本地 stdio、renderer 与 MCP
路径可用，保留本地已完成的 transcript，且绝不因远程 feature flag 变化而重放回合。

## 6. 生产准入

已排期的功能集只有在 E2E-221 至 E2E-226、E2E-229、E2E-230、E2E-231 通过，
集成适配层的 E2E-232 通过，适用于已排期里程碑的远程安全门签核，故障注入证明
含 SSH 会话中断在内的重连不重复执行，桌面发布流水线发布的每个 Linux 平台都有带
checksum 发布到 GitHub Releases 的 `pi-host` 包且版本不匹配与篡改下载路径已测试，Host 运营指标可用，且新的发布/回滚
runbook 写明 feature flag、配对撤销路径、远端机器上的数据保留和事件负责人之后，
才可进入生产。绑定 parity 与 E2E-227 / E2E-228 在其里程碑排期后成为门槛。

## 7. 实现状态

记录于 `feat/remote-agent-host` 分支，2026-09-10：

- R0 已交付：`packages/shared` 中以 typebox 定义的 RACP 契约（`racp.ts`）、生成的
  JSON Schema fixture、本地到 RACP 的事件映射、远程权限上限和共享错误码。
- R1 已交付：host-core 的 `permissions.pending`；无头 `packages/agent-host` 模块（epoch
  事件日志、有界扇出、审批代理、回合队列、快照构建）；在现有 IPC handler 之上承载该
  模块并把每个 agent 事件送入它的 Electron 桥接层；以及 schema v15 的持久化
  `turn_queue` 与其 RPC 方法（D386 / ADR 0213）。
- R1 已交付：renderer 的内存 prompt 队列已退役；composer 经 `agent/queue/push` 推入，
  镜像 `agent/event/queueChanged`，“立即发送”即 `turn/prioritize` 加优雅停止。
- R1 未完成：运行时级别的逐回合权限上限（当前被限制的回合在桥接层直接拒绝）。
- R2 及之后：尚未开始。

## 8. 修订记录

D374（2026-09-10）用无头 Agent Host 模块替换 Electron facade 里程碑，加入
Host 队列与 `permissions.pending`，将 `RACP-WS` 定为 v1 唯一规范绑定并加入
浏览器 profile、保留的 gRPC、Host link 中继与身份源决定，并把租户隔离测试改为
依赖多租户 harness。

D375（2026-09-10）按已记录的需求重排里程碑：R2 为桌面作为客户端的 SSH 隧道
远端 Host，R3 为出站消息集成，Gateway、浏览器与 gRPC 里程碑不排期；并加入
`pi-host` 包、桌面适配层规则以及作为验收目标的 E2E-231 / E2E-232。同日记录的设计
决定把反向工具中继与终端放进 R2 并整体交付，`pi-host` 从 GitHub Releases 下载，
回合队列持久化到 host-core，远程审批默认寿命 30 分钟，配对设备豁免改为 Host 策略，
Gateway 身份源定为 PI 账号服务。

D385（2026-09-10）撤回身份源条款：远程控制从结构上就是用户本地的，Gateway 只能由
用户自托管并以 Host 签发的设备凭据准入。
