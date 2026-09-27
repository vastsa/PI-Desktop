# 远程 Agent 控制交付与验收

- 状态：目标交付规格，属于 MVP 之后
- 决策：D373 / ADR 0205，经 D376 修订
- 英文源规格：[英文源规格](/spec/06-delivery/07-remote-control-rollout)

## 1. 交付边界

当前 MVP 仍然只提供本地 Electron Main、pi sidecar、Rust host-core、
loopback MCP；不得直接暴露 host-core 或现有 IPC。远程工作先从 typebox
契约、无头 Agent Host 模块、fixture 和状态机测试开始，再在显式 feature flag
之后加入传输绑定。

## 2. 里程碑

- R0：在 `packages/shared` 中以 typebox 定义 RACP v1 资源与操作（唯一契约来源），
  生成 JSON Schema fixture，完成错误、游标、epoch、幂等、回合队列、审批
  （含 `allow-session` 与 Plan/Goal 权限模式选择）和远程权限上限的测试向量。
- R1：交付无 Electron 依赖的 `packages/agent-host` 模块，拥有会话/回合准入、
  回合队列、审批代理、带 epoch 的内存事件日志和快照构建；Electron Main 承载它，
  现有 IPC handler 成为适配层。随之交付 host-core 的 `permissions.pending`
  读取，并用 Host 队列替换 renderer 内存 prompt 队列。仅提供开发环境的
  loopback RACP-WS 端点。
- R2：提供 `RACP-WS`、TLS、header profile 认证、服务端请求、心跳、瞬态优先的
  回压、远程权限上限和撤销。
- R3：提供独立 Gateway、Host 出站 Host link（`racp-hostlink.v1`）、瞬态附件中继，
  并在启动时记录身份源（OIDC/OAuth 2.0 或第一方产品账号服务）的决定。
- R4：提供 `RACP-HTTP` 与浏览器 cookie profile；SSE 的 `Last-Event-ID` 采用
  `epoch:sequence` 形式。
- R5：保留的 gRPC 绑定仅在有明确的原生服务消费者或 Gateway 实现需要时交付，
  `.proto` 与客户端由 typebox 来源生成，不是远程控制的发布门槛。

每个阶段都必须保持本地 stdio 和 loopback MCP 不变，并通过远程场景
E2E-221 至 E2E-230；R1 退出条件还包括模块测试不依赖 Electron、晚接入的
客户端能在快照中看到已打开的审批且其决定能关闭本地桌面卡片。

## 3. 实现规则

RACP 服务只调用无头 Agent Host 模块，模块再调用 renderer 使用的同一套
host 与 sidecar 路径；不从网络监听器调用 renderer、`host.proxy` 或 host-core。
Host 拥有活动回合、回合队列和事件游标，客户端生命周期不控制 Agent 执行，
结束回合必须显式调用 `turn/stop` 或 `turn/interrupt`。队列只存在于 Host，
任何客户端（含本地 renderer）不再保留私有队列。回放测试记录初始快照游标、
命令与幂等 key、每个已应用的持久序号、断开点、回放请求和最终快照哈希；
瞬态事件不参与顺序断言，但必须能从快照的 activeItems 重建。每个已发布绑定
必须保持相同的准入/拒绝、授权范围与权限上限、幂等结果、持久事件顺序、
队列顺序、审批生命周期与决策词汇、附件校验和终止状态。

## 4. 验证

必须覆盖生成的 schema 校验、会话/回合/队列/审批/输入/附件状态机、幂等、
游标回放与 epoch 变化、含权限上限与 `allow-session` 策略的角色矩阵、待处理
请求读取的脱敏、已发布 binding 一致性、Gateway 中继的上传边界、慢客户端、
Host/Gateway 重启（含排队回合）、NAT 出站 Host link（含中继的服务端请求和
附件分块）、cookie profile 下的浏览器重连、`auto` 会话上的远程回合以及审计
脱敏。跨租户测试仅在多租户 harness 就绪后执行。运营指标增加队列深度、
epoch 变化次数，以及瞬态/持久分别统计的事件丢弃数。

## 5. 发布与回滚

先发布 typebox 契约、生成的 fixture 和禁用代码路径，再对 allowlist 用户
启用；浏览器 profile 与任何保留绑定作为独立能力加入。kill switch 拒绝新的
远程连接并取消远程主体提交的排队回合，不影响本地桌面。回滚不得重放回合，
必须支持连接撤销、审计和本地会话继续运行。

## 6. 生产准入

只有在 E2E-221 至 E2E-230、远程安全门、所有已发布绑定（至少 `RACP-WS`
与 `RACP-HTTP`）的 parity、故障注入、运营仪表盘和 runbook 全部完成后，
远程能力才可进入生产。

## 7. 修订记录

D376（2026-09-10）用无头 Agent Host 模块替换 Electron facade 里程碑，加入
Host 队列与 `permissions.pending`，将 `RACP-WS` 定为 v1 唯一规范绑定、R4 为
浏览器 profile、R5 为保留的 gRPC，为 R3 加入 Host link 中继与身份源决定，
并把租户隔离测试改为依赖多租户 harness。
