# 01. MVP 里程碑

> **翻译说明：** 本页是与 [英文源规格](/spec/06-delivery/01-mvp-milestones) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 版本切片

### M0 — 规格冻结
- [x] 产品定位
- [x] Electron 路线
- [x] Rust 主机核心路由
- [x] 英语优先的全球化路线
- [x] 插件系统架构
- [x] 私有 GitHub 存储库已初始化

### M1 — 应用程序骨架
状态：**已实施 (MVP)**

Goal：具有双后端骨架的可启动桌面 shell。

可交付成果：
- pnpm monorepo
- Electron 应用程序 (main/preload/renderer)
- 英文语言环境源包
- Rust `host-core` 板条箱骨架 + 健康检查
- Node 代理运行时包骨架
- IPC 端到端健康检查
- 预留PluginManager/CommandPalette接口

退出标准：
- `pnpm dev` 以英语打开窗口
- Electron 可以调用 Rust 主机健康检查
- protocol/version 握手在日志中可见

### M2 — Pi 聊天运行时
状态：**已实施 (MVP)**

Goal：真正的流媒体聊天。

可交付成果：
- pi 运行时集成
- provider/model 设置
- 密钥存储
- prompt/abort
- 流事件用户界面
- 会话持久性基线

退出标准：
- 配置密钥并成功聊天
- 流式令牌可见
- 历史在重启后依然存在

### M3 — 工作区工具
状态：**已实施 (MVP)**

Goal：受控的当地机构。

可交付成果：
- 项目开放
- Read/Glob/Grep/Write/Edit/Bash 通过 Rust 主机
- 许可卡
- 工具痕迹

退出标准：
- 对实际项目完成一项经批准的本地修改
- 拒绝权限路径正确

### M4 — 插件基础
状态：**已实施 (MVP)**

Goal：用户可安装的本地扩展系统。

可交付成果：
- 插件管理器
- 清单验证
- local/dev 插件加载
- 命令面板插件命令
- 示例插件 e2e
- 权限声明UI

退出标准：
- 加载示例插件
- 运行插件命令
- 注册低风险代理工具
- 禁用删除贡献

### M5 — 桌面强化
状态：**除凭据门控 macOS 公证外已完成**

Goal：日常可用的包。

可交付成果：
- 包装（macOS arm64、Intel x64、Windows x64 和 Linux x64 标签工件；D126/D285）
- 设置抛光
- logging/error 边界
- 会话管理基础知识
- 隔离验证

进展：
- [x] 包装脚手架（电子构建器 macOS arm64 `--dir`、host/sidecar 资源）
- [x] 对主要内容进行大量 settings/session/UI 打磨
- [x] 代码签名通道（未签名的本地默认值；开发者 ID + 强化
  运行时 + 由 `scripts/release-macos.sh`、D078 注入的权利）
- [x] 自定义应用程序图标（生成 pi 标记 → `build/icon.icns`，D079）
- [x] isolation/logging 强化（渲染器沙箱 D081、NDJSON 日志
  通道 D082、碰撞监控 D080、窗口状态 D083)
- [x] 打包的 macOS 更新发现、修复的发布链接、键入的更新状态、
  和标签工作流源资产（手动交付，D120 / ADR 0022）
- [ ] 完整的 DMG + 公证 — 操作手册准备就绪
  ([06-release-runbook](/zh-CN/spec/06-delivery/06-release-runbook));仅在 Apple 上被阻止
  开发人员凭证（操作，而非代码）

### M6 — Plan 操作状态
状态：**完成（2026-08-05）**

Goal：用主机权威 Plan 替换以前的聊天操作配置文件
和 Goal 合约在同一 pi Agent 上注明，包括单独的批准
边界。

可交付成果：
- Agent | Plan | Goal 选择器，默认为 Agent
- 持久的 session/settings/scheduled `chat` → `plan` 迁移
- 协议 v9 和模式 v11 具有不可变的主机编写的 `.pi/plan/*.md` 和
  `.pi/goal/*.md` 工件、结构化 title/question 字段以及
`plan_approvals` artifact/execution 字段
- Rust 拥有的模式解析、Plan 工具策略、可选择的 shell 目录
  后备和固定身份，
  流式 Bash 输出、有限超时和进程树取消
- 单代理 `EnterPlanMode` / `SubmitPlan` 和 `EnterGoalMode` / `SubmitGoal`
  具有 approve/reject-only 解决方案和故障关闭恢复的生命周期
- Plan 工件批准 IPC/RPC/events，当前生命周期渲染器投影，
  仅待处理的重新加载水合、外壳选择、批准 UX 和 EN/zh-CN 副本
- 插件拒绝、预定合同拒绝、可选择的 shell 执行、
  重点验证 unit/integration，以及当前的 extension/subagent
  E2E 计划中记录的流程

退出标准：
- 在规划之前、期间和之后仅使用一个 pi Agent
- Plan 拒绝 Write/Edit/plugin 工具，但在选定的情况下公开 Bash
  权限模式，包括 Auto 的显式突变权衡
- 批准与通用工具权限分开，自动选择
  Agent 权限模式，默认 UI 选择为 Ask
- 拒绝并到期离开 Plan 中的会话；主机重启中断
  pending/queued/running 无需重放即可工作，而已经批准的
  中断执行离开会话 Agent
- 渲染器仅在其当前生命周期内保留最新的 Plan 快照；
  `plans.pending` 仅恢复仍待处理的行和截止日期后
  相同主机重新加载，而终端卡未重新水化
- 每个提交的 Markdown 快照都逐字节保存在唯一的
`.pi/plan/*.md` 工件包含记录的 path/hash/size，并经批准后打开它
- Host/storage 恢复、待水合、同寿命终端控制、
  同一主机渲染器重新加载后，rejected/approved 终端卡缺失
  已证明。本地 E2E 执行在显式外部保持选择加入
  请求验收运行

验收证据：host-core migration/policy/recovery 测试，
`test:e2e:plan`、`test:e2e:plan-ui`、desktop/runtime/shared/i18n 套件，完整
JavaScript build/typecheck/lint 和 Electron boot/supervision 探针。的
同一主机 UI 运行涵盖待恢复、实时终端控制、稳定
Electron/Host 身份，渲染器重新加载后终端卡缺失；
E2E-108/E2E-109 覆盖主机重启中断且无重播。

### M6+（当前产品增量）
在 M6 Plan 检查点之后实现：

- Goal 合同和自主批准后执行
- 设置 > 智能体中的技能和 MCP 管理，使用全局/项目 `.agents` 根目录、项目优先
  遮蔽、单文件物理导入和本地启用状态
- 设置 > 智能体中的全局子代理管理，来源为 `~/.agents/subagents`
- 插件市场 installation/update 审查和全局插件启动器
- 会话导入、计划任务记录、通知、剪贴板文件粘贴、
  斜杠命令、`@` 文件引用和下一回合 Composer 配置

剩余工作将作为产品强化而不是未启动的 MVP 范围进行跟踪：

- 更强大的插件运行时沙箱和发布者签名
- signed/notarized macOS 分发和原生 Windows/Linux 资格
- 完整的 Playwright/UI-driven E2E 覆盖
- 附带的 zh-CN 目录之外的其他语言环境

## 释放约束

标签版本发布 **macOS arm64、Intel x64、Windows x64 和 Linux x64** 工件
（D126 解除了原始 D010 仅限 macOS 的限制；D285 增加了本机 Intel 通道）。

## 粗暴的努力（独奏）

| 里程碑 | 估计 |
|---|---|
| 莫0 | 完成 |
| M1 | 1-2天 |
| M2 | 2-4天 |
| M3 | 3-5天 |
| M4 | 3-5天 |
| M5 | 2-4天 |
| M6 | 完成 |
