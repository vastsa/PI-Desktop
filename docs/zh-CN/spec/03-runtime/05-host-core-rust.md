# 05. Rust 主机核心

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/05-host-core-rust) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 目的

`host-core` 是 PI-Desktop 的特权本地后端。

它**不会**取代 pi。它提供安全主机功能：

- Electron 外壳
- pi 代理运行时
- 插件系统

## 2. 职责

1. 工作空间路径规范化、边界检查和权限控制
   显式外部路径
2. 内置工具执行（read/glob/grep/write/edit/bash）
3. 权威的持久会话模式和工具策略评估
4. 权限策略评估，包括Plan/Goal Bash提示
5. 不可变的 `.pi/plan/*.md` 和 `.pi/goal/*.md` 工件编写器，
   `plan_approvals` 经纪人，以及
   启动中断栅栏
6. 可选择的 shell 目录、身份验证、流式输出和进程
   树关闭
7.插件registry/install/lifecycle服务
8. 投稿登记记账（与TS方）
9. 持久性适配器（sessions/settings 元数据、`plan_approvals` 工件
   和执行字段，以及持久通知收件箱）
10. 密钥存储集成点
11.敏感操作的审核日志记录

## 3. 非责任

- LLM提供商SDK
- 代理转graph/orchestration
- React 渲染
- 市场网络前端

## 4. 建议的板条箱布局

```text
crates/host-core/
 src/
 main.rs # sidecar entry
 lib.rs
 rpc/
 tools/
 permissions/
 workspace/
 plugins/
 storage/
 notifications.rs
 secrets/
 audit/
 util/
```

## 5. RPC 传输

冻结：**stdio JSON-RPC NDJSON** 和 Electron main（请参阅 `06-host-rpc-protocol.md`）。

### 5a。控制管道资源隔离

主机的标准输入读取器和标准输出写入器各自运行在一个指定的专用操作系统上
线程。他们不得使用 Tokio 的 `tokio::io::{stdin, stdout}` 适配器：那些
适配器为每个操作获取一个阻塞池工作线程，以及一个耗尽的操作系统
否则，线程预算可能会在结构化错误到达之前使主机陷入恐慌
Electron。专用线程重试 `EINTR` 和瞬态 React/RPC
(`errno` 11 或 35) 具有短延迟，保留 NDJSON 帧，并且仅停止
EOF 或不可恢复的管道错误。无法创建任一控制线程
是启动错误而不是未处理的恐慌。

尽力而为的登录 shell 路径探测遵循相同的规则：探测失败
线程创建返回 `None`，因此 Bash 回退到主机环境。

## 5b. RPC 表面（逻辑）

域名：

- `app.*`
- `workspace.*`
- `tools.*`
- `permissions.*`
- `plugins.*`
- `session.*`（适配器级别）
- `notification.*`（适配器级别；耐用收件箱）
- `plans.*`（批准经纪人和恢复）
- `shell.*`（目录和默认选择）
- `settings.*`（适配器级别）
- `secrets.*`
- `audit.*`

示例：

```text
tools.execute
plans.resolve
plans.pending
permissions.request
plugins.list
plugins.load_dev
workspace.set
secrets.set
notification.list
```

## 6. 安全不变量

1. 工作区工具或 `.pi/plan/*.md` 中没有未经检查的路径转义；一个
   仅在主机权限评估后才能解析显式外部路径
2、Host解析持久会话模式；请求提供模式永远不会
   权威的
3. Plan 和 Goal 在权限评估之前拒绝 write/edit/plugin/unknown 工具
4. Plan 和 Goal Bash 遵循持久权限模式，在 Auto 下可能会发生变异
5. Plan 和 Goal 工件字节、路径、散列、大小和 approval/execution 标识为
   主机验证
6. Plan/Goal 批准在 Agent 条目之前经过主机验证、持久且原子
7. 在生成前检查有效的 shell ID/dialect；设置拒绝
   unavailable/wrong-platform ID，并且持续不可用的选择失败
   仅在目录选择期间返回
8. 秘密永远不会返回到渲染器日志中
9. 插件、shell 或批准路径中的崩溃失败关闭并且不授予或
   重放执行

## 7. 包装

- 为每个平台建立目标
- 将二进制文件发送到 Electron 资源旁边
- 使用 Electron/Node 进行版本化协议握手

## 8. MVP 接受

1. Electron 可以启动 Rust 主机 sidecar
2.健康检查RPC成功
3. 至少一条刀具路径通过 Rust 执行
4. 权限拒绝路径有效
5. 未见的 completed/failed 轮流恰好创建一个持久通知
   通过 `session.endTurn` 交易；结果已经可见
   集中当前的聊天和中止的回合不会创建任何内容
6. 持久 Plan 或 Goal 会话无法通过以下方式授权 write/edit/plugin 工具：
   冲突的请求模式，并且 Plan/Goal Bash 遵循已解析的权限
   模式
7. SubmitPlan 将精确的 Markdown 字节写入新的 `.pi/plan/*.md` 工件并
   将持久的 path/hash/size 和结构化的 title/question 存储在
   `plan_approvals`；批准为 approve/reject-only、session/turn/version
   范围内，并在 30 绝对分钟后到期
   `PLAN_APPROVAL_TIMEOUT`
8. Pending/queued/running Plan 或 Goal 工作在主机重新启动时中断，且没有
   重播；批准的中断离开会话 Agent
9. Shell selection/fallback、过时的 ID/dialect 拒绝、stdout/stderr
   流式传输、60 秒超时、有界覆盖和进程树中止
   主机强制
