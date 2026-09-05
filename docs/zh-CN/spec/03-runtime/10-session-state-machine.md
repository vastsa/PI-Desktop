# 10. 会话、Plan 和 Goal 状态机

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/10-session-state-machine) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 0. 持久运行模式与实时规划状态

每个会话仅保留一种操作模式：`agent | plan | goal`。那里
是一
pi Agent。实时计划状态和执行状态是 host/runtime 投影。
Plan 和 Goal 是**合约模式**：两者在执行之前协商提案
并共享一项预测、一项批准行和一项硬否认 (**D198**)。 `kind`
(`plan | goal`) 是区分它们的地方，下图读起来是一样的
将 Goal/Plan 替换为 Plan/Goal：

```text
Agent / inactive
  -- user selects Plan while idle OR Agent calls EnterPlanMode --> Plan / planning
  -- user selects Goal while idle OR Agent calls EnterGoalMode --> Goal / planning
Plan | Goal / planning
  -- SubmitPlan | SubmitGoal (title, markdown, question) --> awaiting_approval
Plan | Goal / awaiting_approval
  -- approve(permission mode) --> Agent / queued, same Agent continues
  -- reject | expiry | abort | crash | persistence failure
       --> same contract mode / planning
Agent / queued
  -- dispatcher starts --> Agent / running
Agent / running
  -- complete | fail | abort --> Agent / inactive
```

两种合约模式都保留了权限模式选择器。他们的 `Bash` 政策是
`ask` 或
`accept-edits` = 确认，`auto` = 不确认，所以是合约模式
表达协商意图，但不是严格的只读安全配置文件。
Write/Edit 和
在每个 Plan 或 Goal 权限模式下，插件工具仍被主机策略拒绝。

这些类型的区别仅在于合同内容和排队执行内容
指令要求：Plan 建议执行有序步骤，而 Goal
提出目标陈述、验收标准和界限，及其
执行持续进行——选择自己的方法——直到每次接受
标准被验证或边界阻止它。

仅允许通过 UI/session API 进行模式和配置更改
空闲时。批准不是通用工具权限：它是单独的
主机拥有的状态转换。主机重启会中断每个待批准的任务
和 queued/running 执行字段，无重放；一个已经批准的
中断将持久会话保留在 Agent 中。

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

## 3. 转换规则

1. 每个会话只有一个有效回合
2. 新提示被 `AGENT_BUSY` 拒绝，而 running/waiting_permission
3. 允许中止运行或 waiting_permission。 Renderer 智能停止
   删除未应答的 root 用户行并恢复其 session/turn-scoped
   预序列化输入框快照；曾经助理文字、思考或任何
   工具行开始，中止保留部分转录本并恢复不
   草稿。
4. 权限超时变为工具被拒绝，然后代理可以根据运行时处理继续或结束
5. 终端回合状态持久后，会话状态返回空闲状态
6. 更改渲染器的活动 project/session 不会转换或中止
   任何后台会话
7. 工具转换保留原始会话的持久项目根；
   它从不采用新活动项目的根
8. `session.endTurn` 仅将 `running` 转至终端。在那个同
   事务，未见的 `completed` 插入 `task.completed`，未见的 `error`
   插入 `task.failed`，并且结果已在焦点当前中可见
   聊天或任何 `aborted` 回合不会插入任何通知 (D117)。重复终端
   调用是无操作的。
9. 仅当源空闲时才允许分叉。孩子开始无所事事
   没有回合或等待许可状态。 Electron 返回 `AGENT_BUSY` 的
主动运行时保护并规范主机的持续运行轮流
   `CONFLICT` 回退到相同的 IPC 错误。两条路径均不产生部分
   孩子。
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
- assistant/tool 消息：在 message_end/tool_end 上。再验证仍在运行的
  会话时，把有界持久化页按时间顺序缝到实时快照上，使更早的实时
  行留在该页之前、进行中的尾巴留在该页之后（D317）
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
6. 空闲分叉作为独立的空闲会话启动；繁忙的信号源无法
   生一个孩子
7. 消息范围的分叉排除后面的行并且从没有源运行时开始
   或提供商缓存状态
8. Plan、Goal 和 Agent 使用 1 个 pi Agent； Composer-左模式芯片、UI
   条目，以及
   `queued`/reject/expiry/interruption 收敛于相同的规划状态，并且
批准恢复
   Agent 模式下的 Agent
9. 合约模式策略仅通过选择的权限模式允许Bash
   和
   在 Goal 中拒绝 Write/Edit/plugins，无论 `auto` 或会话授权如何
   与 Plan 完全相同
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
