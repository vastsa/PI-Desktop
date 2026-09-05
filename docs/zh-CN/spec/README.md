# PI-Desktop 规格

> **翻译说明：** 本页是与 [英文源规格](/spec/README) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


> 冻结基线：`0.4.16` · 当前应用版本线：`0.13.3`
> 更新：`2026-09-05`
> 语言： **英语优先**
> 堆栈：Electron + **Rust 主机核心** + pi Agent 线束 + 用户可安装的插件

基线是一个冻结的决策工件，而不是每个的完整列表
当前应用程序中的功能。当前的实现添加了 Goal 合约，
独立 MCP/Skills/Subagents、插件市场和启动器流程、会话
导入、计划任务和下一轮输入框配置。主机线材
协议为 v10；存储架构为 v12（见 `00-baseline.md`）。

## 快速进入

| 医生 | 描述 |
|---|---|
| [NAV.md](/zh-CN/spec/NAV) | 单页完整导航 |
| [00-基线.md](/zh-CN/spec/00-baseline) | 冻结基线 |
| [08-meta/decisions-log.md](/zh-CN/spec/08-meta/decisions-log) | 冻结细节决策 |
| [01-product/00-overview.md](/zh-CN/spec/01-product/00-overview) | 概述 |
| [01-product/01-product-scope.md](/zh-CN/spec/01-product/01-product-scope) | 目前的产品范围和运营模式 |
| [02-architecture/01-architecture.md](/zh-CN/spec/02-architecture/01-architecture) | 建筑 |
| [03-runtime/05-host-core-rust.md](/zh-CN/spec/03-runtime/05-host-core-rust) | Rust 主机核心 |
| [04-ux/02-i18n-english-first.md](/zh-CN/spec/04-ux/02-i18n-english-first) | 国际化政策 |
| [04-ux/07-ui-design-system.md](/zh-CN/spec/04-ux/07-ui-design-system) | 设计系统（令牌、运动、密度） |
| [04-ux/01-ui-ia.md](/zh-CN/spec/04-ux/01-ui-ia) | 已发货的外壳和目的地地图 |
| [../project/plan-mode-implementation-plan.md](/project/plan-mode-implementation-plan) | Plan 运行状态实施计划 |
| [07-plugins/01-plugin-system.md](/zh-CN/spec/07-plugins/01-plugin-system) | 插件系统 |
| [06-delivery/03-ai-development-workflow.md](/zh-CN/spec/06-delivery/03-ai-development-workflow) | AI开发工作流程规则 |
| [06-delivery/04-e2e-test-plan.md](/zh-CN/spec/06-delivery/04-e2e-test-plan) | E2E 测试计划和场景 |
| [06-delivery/05-change-checklist.md](/zh-CN/spec/06-delivery/05-change-checklist) | 更改清单 |

## 目录映射

```text
docs/spec/
├── 00-baseline.md
├── 01-product/
├── 02-architecture/
├── 03-runtime/
├── 04-ux/
├── 05-security/
├── 06-delivery/
├── 07-plugins/
└── 08-meta/
```

## 阅读路径

### 产品
1.`00-baseline.md`
2.`01-product/00-overview.md`
3.`01-product/01-product-scope.md`
4.`06-delivery/01-mvp-milestones.md`

### 实施
1.`00-baseline.md`
2.`02-architecture/01-architecture.md`
3.`03-runtime/05-host-core-rust.md`
4.`03-runtime/02-agent-runtime.md`
5.`03-runtime/01-ipc-protocol.md`
6.`03-runtime/11-provider-model-system.md`
7.`07-plugins/01-plugin-system.md`

### 插件作者
1. [`../plugin-development.md`](/zh-CN/plugin-development)
2.`07-plugins/01-plugin-system.md`
3.`07-plugins/02-plugin-manifest-schema.md`
4.`07-plugins/03-plugin-api.md`
5.`07-plugins/10-plugin-devex.md`
6.`examples/plugins/hello`

## 冻结的决定（短）

1.Electron外壳
2. 英文优先的product/docs
3.Rust主机后端核心
4. Node sidecar 中的 pi 代理引擎
5. 主机 RPC = stdio JSON-RPC NDJSON
6. SQLite 仅由 Rust 拥有
7. 默认模式=Agent；操作选择器 = Agent | Plan | Goal。 Plan 和 Goal
   是相同 Agent 的合约状态，并且不是严格的只读安全性
   配置文件，因为 Bash 遵循所选的权限模式
8. SubmitPlan 将精确的 Markdown 字节写入新的主机拥有的
   `.pi/plan/*.md`神器； title/question 保持结构化
   `plan_approvals`，批准打开工件，仅限 approve/reject，并且
   `PLAN_APPROVAL_TIMEOUT` 在 30 绝对分钟后过期
9.协议v10和存储模式v12对Plan/Goal具有权威性
检查点、`plan_approvals` 执行字段、启动中断和
   外壳身份
10、权限超时120s拒绝； Bash 超时默认 60 秒
11.本地用户可安装的插件（稍后上市）
12. 标签版本 = macOS arm64、Intel x64、Windows x64 和 Linux x64 (D126/D285)
13. 通用 provider/model 覆盖范围（原生 + OpenAI 兼容 + 定制）
