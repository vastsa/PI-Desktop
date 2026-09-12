# 01. 架构

> **翻译说明：** 本页是与 [英文源规格](/spec/02-architecture/01-architecture) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 概述

PI-Desktop 使用分层桌面架构：

```text
┌──────────────────────────────────────────────────────────┐
│ Renderer (React UI, English-first i18n) │
│ - chat / sessions / settings / plugins / command palette│
│ - no Node integration │
└───────────────────────────▲──────────────────────────────┘
 │ preload IPC
┌───────────────────────────┴──────────────────────────────┐
│ Electron Main (thin orchestrator) │
│ - window lifecycle │
│ - IPC routing │
│ - process supervision │
└───────────────▲─────────────────────────────▲────────────┘
 │ local RPC │ process bridge
┌───────────────┴──────────────┐ ┌──────────┴────────────┐
│ Rust Host Core │ │ Node pi Agent Sidecar │
│ - tools + sandbox │ │ - pi-ai │
│ - permission gateway │ │ - pi-agent-core │
│ - plugin host services │◄─►│ - turn orchestration │
│ - persistence adapters │ │ - provider streaming │
│ - secrets adapter │ └───────────────────────┘
└──────────────────────────────┘
```

## 2. 设计原则

1. **UI和特权运行时是分离的**
2. **Rust拥有host/system的能力、持久模式和审批政策**
3. **pi 拥有 model/agent 循环语义**
4. **Renderer 没有特权**
5. **所有跨边界契约均已类型化**
6. **英语是产品源语言**
7. **Plan 是第一个 pi Agent 的状态，而不是第二个规划器**

## 3. 子系统

### 3. 1 应用程序外壳 (Electron)
- windows/menus
- 应用程序生命周期
- 固定源更新 check/download/install 生命周期
- 处理启动顺序

Electron Main 独家拥有更新客户端和修复的 GitHub 版本
目标。渲染器可以请求白名单操作并渲染类型化状态，
但无法提供提要 URL 或直接访问更新程序。应用程序更新可以
不通过 Rust host-core 或代理 sidecar (D120 / ADR 0022)。

### 3. 2 用户界面（React）
- 会话用户体验
- 流媒体转录
- 许可卡
- 设置
- 插件管理器用户界面
- 命令面板

### 3. 3 Rust 主机核心
- 工作空间路径强制
- 内置工具执行
- 权限策略评估
- 持久会话模式解析（`agent | plan`）
- 计划批准记录、请求和原子 Plan → Agent 转换
- 插件 install/registry/lifecycle 服务
- sqlite 适配器/安全存储胶
- 审计日志

### 3. 4 Node pi Agent 运行时
- 模型 catalog/provider 设置
- `Agent.prompt/abort`
- pi 事件的事件标准化
- 向主机核心发出工具调用请求
- 单代理规划状态、主机编写的 Plan 检查点提交，以及
  approve/reject 执行边界

### 3. 5 插件系统
- 清单验证
- 捐款登记处 (commands/tools/skills)
- 插件面板
- 授予许可

### 3. 6 本地 MCP 控制面

设置 `PI_DESKTOP_MCP_CONTROL=1` 时，Electron Main 会在 `127.0.0.1` 启动可选的
Streamable HTTP MCP 服务。服务提供项目/会话/Agent/工作区常用命名工具，以及经过
审查的通用桌面操作目录。每次调用都委托给渲染器使用的同一主进程 IPC 处理器，不会
创建第二套权限或持久化实现。

服务在 Electron 用户数据目录创建 bearer token 和连接清单，只绑定回环地址，不暴露
密钥通道、provider/OAuth/MCP 密钥写入路径，或渲染器专属原生选择器。危险通用操作和
`session/configure` 要求 `confirm: true`，这是 Agent 确认而非用户弹窗。成功的
**变更性** 项目/会话调用复用现有会话变更事件，使外部 Agent 和可见桌面收敛到同一状态。
这是本地自动化接口，不是延后的远程 Gateway / WebUI 架构。

### 3.7 远程 Agent Control 目标（MVP 后）

远程控制在 [05-remote-agent-control](/zh-CN/spec/02-architecture/05-remote-agent-control)
中单独定义。目标是在现有 sidecar 之上增加无头 Agent Host 模块，并暴露与传输无关的
RACP 契约：WebSocket JSON-RPC 是 v1 规范绑定，HTTP/JSON + SSE 是其浏览器 profile，
gRPC 保留（D374）。它不暴露 Electron IPC、`host.proxy` 或 host-core RPC，也不改变当前
MVP 对远程 Gateway 的排除。首个实现把该模块放在 Electron Main 内，桌面 IPC、本地 MCP
和 RACP 都调用它。首个远程部署（D375）把同一模块打包为另一台机器上的无头 `pi-host`，
桌面经 SSH 隧道连接；Gateway 路由与浏览器访问保留规格但不排期。

## 4. 请求路径（对话+工具）

```text
1. UI submits prompt
2. Electron main routes to agent sidecar
3. pi runtime starts turn and streams events
4. UI renders text deltas
5. On tool call:
 5.1 pi requests tool execution via host bridge
  5.2 Rust resolves the durable session mode and evaluates the authoritative
      Plan/Goal/Agent tool policy before permission modes
  5.3 UI confirms if required, including a separate Plan/Goal approval request and
      the selected shell identity for Bash
 5.4 Rust resolves the durable session's project and executes the tool in that
     workspace sandbox (never whichever sidebar tab is currently active)
 5.5 result returns to pi runtime
6. turn ends; session persistence updates
```

当同一个 Agent 调用 `SubmitPlan` 时，host-core 会保留确切的 Markdown
新的不可变 `<workspaceRoot>/.pi/plan/*.md` 工件中的字节，记录其
`plan_approvals` 中的相对 path/hash/size 和结构化 title/question，以及
等待 `plans.resolve`。批准卡打开该工件。批准
使用所选权限自动将持久会话更改为 Agent
模式并排队新的执行轮次。拒绝、过期、host/sidecar 崩溃以及
持久性失败不授予任何执行能力。启动交易
在 RPC 之前中断待批准和 queued/running 执行字段
服务，无重播；已批准的中断执行离开
Agent 中的会话。

渲染器可能会显示 Plan 状态和批准 UI，但这只是一个投影
当前渲染器生命周期的实时 host/runtime 事件的数量。它保留了
渲染器内存中每个会话的最新 proposal/execution 快照；渲染器
reload 仅通过 `plans.pending` 重新水化仍待处理的行，而不是
终端审批或执行卡。它无法授权工具或选择模式
通过发送冲突的请求字段来获取主机策略。

渲染器可能会保留多个项目选项卡，但这不会创建多个项目选项卡
宿主工作区单例。一个项目提供可见的 shell 上下文；
会话绑定的项目身份提供每个回合的特权工具根。

## 5. 为什么混合 Rust + pi

| 方法 | 判决 |
|---|---|
| 纯 TS Electron 主要用于一切 | 更简单、更弱的系统边界 |
| 代理循环的完整 Rust 重写 | 太贵了，失去了 pi 杠杆 |
| **Rust 主机 + pi sidecar** | 选择：强大的主机+成熟的代理引擎 |

## 6. 进程模型

传输：Rust sidecar + stdio JSON-RPC (NDJSON)。

MVP 目标进程：

1.Electron主要（包括可选的回环 MCP 控制服务）
2.Electron渲染器
3. Rust 主机内核 sidecar
4. Node pi 代理 sidecar

开发模式可能会托管一些服务，但合同保持不变。

## 7. 扩展点

- 工具提供程序（内置/插件/用户 MCP）
- 面向已审查桌面操作的本地 MCP 控制客户端
- 会话后端
- 模型目录来源
- 权限策略包
- 语言环境包
- 市场提供商（后 MVP）

## 8. 包装影响

台式机包装必须运送：

- Electron 应用程序
- 一个目标本机 Rust 主机二进制文件
- `Resources/agent-runtime/sidecar.js` 下的一个捆绑 pi sidecar 条目，运行
  通过 Electron 二进制文件和 `ELECTRON_RUN_AS_NODE=1`
- 英文和简体中文产品区域设置目录，仅加上
  这些产品语言所需的 Chromium 语言环境包
- 仅在保留的能力无法安全捆绑时，才携带目标本机运行时模块

仅渲染器库是构建输入。 Vite 必须发出可执行文件
`out/renderer` 下的代码和惰性资产；电子制造商不得也复制
他们原来生产的`node_modules`树变成了ASAR。 Electron 主要可能
内联纯 JS 工作区助手，同时保留本机或运行时解析的模块
外部。发布包不包括依赖源映射、测试、示例、
声明和非目标本机预构建，无需替换本地资产
与网络获取。
