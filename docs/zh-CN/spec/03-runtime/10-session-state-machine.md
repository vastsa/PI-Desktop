# 10. 会话、Plan 和 Goal 状态机

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/10-session-state-machine) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 0. 持久运行模式与实时规划状态

每个会话持久化 `agent | plan | goal`，并使用同一个 pi Agent。Plan 保留
`planning -> awaiting_approval -> Agent queued/running` 流程；拒绝、到期或中断提案
都不授予执行权限。已有的旧版 Goal 审批保留相同的处理和执行路径。
新 Goal 工作使用下述独立生命周期，而不是 `PlanningState`。

## 自主 Goal 生命周期

| 状态 | 含义 / 退出条件 |
|---|---|
| `active` | 用户已授权工作；准入流程可领取下一个执行轮 |
| `paused` | 用户暂停、模式切换、中止或重启；需要用户明确恢复 |
| `blocked` | 已报告阻塞或执行失败；需要用户明确恢复 |
| `completed` | 全部已存储标准达成，且版本化模型审计已被接受；终态 |
| `budget_exhausted` | 下次准入时预算不足；用户可提供足够预算后恢复 |
| `cancelled` | 用户明确取消；终态 |

只有用户所有者明确启动或恢复，才授权执行。仅选择 Goal 模式不会执行；
直接在 Goal 模式发送可启动工作，无需 Plan 审批。默认预算为包含初始轮的
20 个执行轮，不是 20 次工具调用或模型请求。仅在创建目标时快照
settings.defaultGoalBudget。显式 maxTurns=null 表示无限轮次；没有 maxTokens
表示无限 Token。已有有限预算即使在默认值改变后也保持不变；
修改设置或设为无限预算都不产生新的执行授权。
可选 Token 上限是软限制，在下一次准入时使用已结算的父级和委派用量检查；
正在执行的工作可能超出上限。

共享的 `AgentHost`/`GoalCoordinator` 准入流程串行处理用户队列与 Goal 续跑，
用户工作优先。Rust revision CAS 和唯一轮次 claim 防止重复启动。
`goal_turns` 在 `agent_end` 前记录幂等结算；续跑的系统上下文不新增用户转录行。
暂停和取消先持久化，再取消运行时工作。离开 Goal 模式会暂停目标；
运行时配置仍遵守活动轮边界。启动时暂停 active 目标并清除中断的 claim，不重放。
恢复不能与尚未结算的 claim 竞争；completed/cancelled 目标不能恢复。

用户所有者只能编辑已停止、非终态且 claim 已结算的目标。编辑使用 revision CAS，
替换目标和标准、清除旧报告及审计，保留预算、用量和耗时，并返回 paused。
保存不授权执行。删除在中止运行时工作前持久化 cancelled 逻辑墓碑，
只移除当前 Goal 展示，不删除聊天、todo 或 claim。迟到报告不能复活目标；
迟到用量只结算原 claim。旧 claim 未结算前不能启动替代 Goal。
通知携带移除身份和 revision，防止迟到加载复活已删目标或清除新目标。
Host 持有的活动耗时排除暂停和离线时间，导航后保留；
恢复可能丢失尚未检查点化的崩溃尾段，而不会虚构耗时。

`GetGoal`/`UpdateGoal` 由 Host 绑定活动 session/goal/turn。报告不能修改范围和预算，
也不授予暂停、恢复、取消或创建权限。完成报告必须恰好覆盖全部已存储标准，
每项为 `met` 且证据非空；Host 还要求针对精确原始目标的版本 1 审计，
要求项非空、全部报告达成并带证据，且没有剩余工作。当前模型必须对完整范围的
权威当前状态证据进行审计，不能重新定义成功。结构校验失败的报告可以修正，
但不会完成 Goal。Host 校验的是结构，**不是模型证据的真实性或语义覆盖完整性**。

Goal 使用 Agent 的普通 Write/Edit、Task 和插件策略，包括路径、沙箱、权限、
授权和拒绝检查；Plan 的硬拒绝保持不变。仍拒绝计划或无人值守方式创建 Goal。
旧版 `EnterGoalMode` 和 `SubmitGoal` 创建入口禁用；已有审批不会被自动授权，
也不会迁移为 `session_goals`。

以下其余审批不变量和工件规则适用于 Plan 与已有的**旧版 Goal 审批**，
不适用于新的自主 Goal 执行。

## 1. 会话状态

```text
idle <-> running <-> waiting_permission
           \/ aborted
           \/ error
```

| 状态 | 意义 |
|---|---|
| `idle` | 无主动回合 |
| `running` | model/tool 激活 |
| `waiting_permission` | 因用户权限决定而被阻止 |
| `aborted` | 当前轮次的终端（然后返回空闲） |
| `error` | 当前轮次的终端（然后返回空闲） |

## 2. 转向生命周期

```text
accept_prompt
 -> turn_start
 -> streaming
 -> (optional tool_loop)
   -> permission_maybe
   -> tool_exec
 -> turn_end
```

回合会到达三种终止原因之一 —— `completed`、`aborted` 或 `error` —— 与
第 1 节状态表中 `aborted` / `error` 两行一致。终止原因只决定一次：
中止会在取消请求发出之前记录其决定，因此之后的 `agent_end` 无法把已中止的
回合改述为已完成。终止事件按回合身份归属，而不是按会话：某个终止事件
所属的回合若已不再拥有该会话，它既不改变当前回合的状态，也不释放其资源，
迟到的消息行和工具行仍作为历史记录。宿主在每次已开始的回合中通过
`session:turnEnded` 插件事件宣告一次终止状态（见 ADR 0252，
`docs/adr/0252-plugin-host-turn-end-event.md`）。

转向输入按同一身份判定：命名了一个已取消、已开始收尾或已不再拥有该会话的回合的输入，
会以「回合已结束」被拒绝。

## 3. 转换规则

1. 每个会话只有一个有效回合
2. 新提示被 `AGENT_BUSY` 拒绝，而 running/waiting_permission 期间 renderer 的
   运行中发送路径经 `agent/queue/push` 把下一条 prompt 推入 Host 拥有的回合队列
   （架构 v15，D375 / D386 / ADR 0213），并从 `agent/event/queueChanged` 镜像持久
   条目；Agent Host 模块在 `agent_end` 之后释放一条，恢复的队列挂起到 owner 接入，
   `agent/queue/prioritize` 把条目移到队列头部，因此正常的用户发送不会看到
   `AGENT_BUSY`。
3. 允许中止运行或 waiting_permission。 Renderer 智能停止
   删除未应答的 root 用户行并恢复其 session/turn-scoped
   预序列化输入框快照；曾经助理文字、思考或任何
   工具行开始，中止保留部分转录本并恢复不
   草稿。
4. 权限超时变为工具被拒绝，然后代理可以根据运行时处理继续或结束
5. 终端回合状态持久后，会话状态返回空闲状态。父级终态错误会中止残留委托，因此“继续”不会变成 `AGENT_BUSY`（D352）。系统中断的委托以失败结算并保留手动恢复资格；显式 Stop 和销毁仍不可恢复
6. 更改渲染器的活动 project/session 不会转换或中止
   任何后台会话
7. 工具转换保留原始会话的持久项目根；
   它从不采用新活动项目的根
8. `session.endTurn` 仅将 `running` 转至终端。在那个同
   事务，未见的 `completed` 插入 `task.completed`，未见的 `error`
   插入 `task.failed`，并且结果已在焦点当前中可见
   聊天或任何 `aborted` 回合不会插入任何通知 (D117)。重复终端
   调用是无操作的。
9. Whole-session fork is idle-only. A running Desktop source may fork a
   completed assistant prefix with no indexed rows owned by a running turn.
   The parent continues and the child starts idle. Other busy forks return
   host `CONFLICT` / IPC `AGENT_BUSY`; native Pi keeps its existing idle and
   ownership guards. Refusal never produces a partial child.
10. 提供 `throughMessageId` 仅更改快照边界。助理
    Fork/Edit 仍然创建一个新的空闲会话 ID，没有共享轮次，
    权限等待、运行时或提供商缓存状态 (D134)。
11. `EnterPlanMode`、`EnterGoalMode`、`SubmitPlan` 和 `SubmitGoal` 必须是
    他们中唯一的工具调用
    助理批次。提交工具在新的文件中保留精确的 Markdown 字节
    主机拥有的 `.pi/<kind>/*.md` 工件并创建一个待处理的
    `plan_approvals` 行及其 `kind` 加上结构化的 title/question 和
    神器领域。针对另一种模式调用的提交工具失败
    与 `PLAN_KIND_MISMATCH` 并且什么也不写。
12. 只有匹配的 `plans.resolve` 才能解决待处理的提案。批准
    以原子方式将持久模式更改为 Agent，存储选定的显式
    权限模式，分配执行ID，并更改行的
    `execution_state` 至 `queued`。
13. 批准和拒绝是唯一的解决方案操作。拒绝和到期
    关闭挂起的行，然后将活动状态返回到可编辑状态
    同合同模式规划状态
    并且不授予任何执行工具。待处理的中断也会执行相同的操作；一个
    批准后 queued/running 中断仍保持 Agent。
14. 第二次提示，Plan 或 Goal 提交、配置更改或执行
    是
在会话处于活动状态、等待批准时被拒绝，或者
    queued/running 执行。仅当空闲时才接受配置。
15. 同一合同模式的后续转变可能会修改
    rejected/expired/interrupted 检查点和
    必须创建一个新的不可变工件而不是覆盖早期的工件
    快照。

## 4. 持久化点

消息持久化按照 04-data-storage §5 (D119) 分为两步：fsync'd
转录文件行第一，索引事务第二。

- 用户消息：接受时
- 转运行行：开始+终端`session.endTurn`更新
- 通知行：与看不见的 completed/error 终端相同的交易
  更新；决不会为了可见的当前结果或中止
- assistant/tool 消息：在 message_end/tool_end 上。完成的助手快照在
  outbox 追加之前先做检查点；握手在冷启动 `session.get` 之前等待该
  排空（D327）。再验证仍在运行或
  刚完成、实时行尚未刷入磁盘的会话时，把有界持久化页按时间顺序缝
  到实时快照上，使更早的实时行留在该页之前、进行中或尚未刷入的尾巴
  留在该页之后（D317、D324）。只有当该页已包含每一条实时行时才清掉
  实时来源标记。
- 孤儿会话恢复：活着的 JSONL 若 sessions 行已不在，则在主机启动和
  `session.appendMessage` 时重新插入；排队的 outbox 在恢复后排空，
  `session.delete` 丢掉该会话的 outbox 条目（D318）
- 未应答的智能停止：标记在现有生命周期中中止的回合，
  然后以原子方式将记录重写为其根用户行之前的前缀；
  结构化输入框快照仅保留渲染器内存
- mode/project 字段：更改时
- Plan/Goal 提交：将精确的 Markdown 字节写入新的唯一值
  `.pi/<kind>/*.md`，
  记录 path/hash/size 加上类型和结构 title/question，然后插入
  `pending`
  批准事件之前的 `plan_approvals` 行
- Plan/Goal审批：审批结果、模式转换、权限模式、
执行
  一笔交易中的 ID 和 `queued` 状态； reject/expiry/interruption 保留
  合同模式并将实时规划返回可编辑状态
- 启动恢复：以事务方式中断待批准的任务
  queued/running 在服务 RPC 之前执行状态；中止关联的运行
  轮流工作并且永不重播
- 分叉快照：新的转录文件加上一个子 session/index 交易；
  源持久性保持不变；消息范围的快照结束
  包含在所选消息中

## 5. 验收

1. 繁忙会话无法启动第二个并发轮次
2. Abort是幂等的
3. waiting_permission在UI状态中可见
4. 两个保留的项目选项卡中的会话可以独立运行，无需
   转录事件或工作空间根交叉
5. 每个未见过的 completed/failed 回合恰好产生一条通知记录
   而可见当前结果或中止的回合不会产生任何结果
6. A fork starts as an independent idle session; a busy Desktop source may
   fork only a completed assistant prefix outside its running turn
7. 消息范围的分叉排除后面的行并且从没有源运行时开始
   或提供商缓存状态
8. Plan、Goal 和 Agent 使用同一个 pi Agent。Plan 审批恢复 Agent 执行；
   新 Goal 仅在用户授权下，通过独立生命周期启动或恢复。
9. Plan 保留模式硬拒绝；Goal 遵循普通 Agent 权限策略。
   旧版审批处理不授予自主循环权限。
10. SubmitPlan/SubmitGoal 使用以下命令写入精确唯一的 `.pi/<kind>/*.md` 工件
    hash/size，
    保持 title/question 结构化，并且只有 approve/reject 可以解析其
    `plan_approvals` 行
11.到期使用`PLAN_APPROVAL_TIMEOUT`；启动中断、shell故障、
    进程恢复失败关闭，并且重新启动不会重放挂起，
    排队或正在运行的工作
12. Goal 执行在结束前报告每个接受标准的结果
    转牌圈，并且 scheduled/unattended Goal 跑路被拒绝
    `PLAN_REQUIRES_INTERACTIVE_SESSION` 与 Plan 完全相同
