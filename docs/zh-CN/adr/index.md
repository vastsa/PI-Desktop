---
title: 架构决策记录
description: 与英文 ADR 一一对应的 PI-Desktop 架构决策阅读入口。
---

# 架构决策记录

ADR 记录那些不应被静默改变的架构选择。中文入口与英文索引保持相同结构；完整记录、状态和决策编号继续以英文页面为源事实。

## 重点决策

| 决策 | 说明 |
|---|---|
| [ADR 0001：Electron 桌面壳](/adr/0001-use-electron) | 桌面窗口与平台能力的承载层 |
| [ADR 0005：本地插件系统](/adr/0005-user-installable-plugin-system) | 用户安装插件的第一阶段边界 |
| [ADR 0009：English-first 全球化](/adr/0009-english-first-globalization) | 源语言、术语和协作规则 |
| [ADR 0010：Rust host core](/adr/0010-rust-backend-host-core) | 特权进程、RPC 与持久化的宿主边界 |
| [ADR 0053：Plan checkpoint](/adr/0053-plan-checkpoint-artifact-and-execution-epoch) | 计划审批、artifact 和执行 epoch |
| [ADR 0079：VitePress 文档站](/adr/0079-vitepress-documentation-site) | 双语文档站的结构与部署方式 |
| [ADR 0083：自定义全局界面字体](/adr/0083-custom-global-ui-font) | 设置字体选择器、内置开源字体与系统字体枚举 |
| [ADR 0089：主动后台子代理委托](/adr/0089-proactive-background-subagent-delegation) | 非阻塞 Task、TaskWait/TaskList/TaskStop 生命周期与权限作用域 |
| [ADR 0090：用户可配置的关闭行为](/adr/0090-user-configurable-close-behavior-close-to-tray) | 首次关闭只问一次，关闭到托盘或退出，设置里可改 |
| [ADR 0095：用厂商账户登录](/adr/0095-vendor-account-oauth-login) | 用订阅账户代替 API 密钥，凭据留在主进程，sidecar 按请求取短时令牌 |
| [ADR 0106：核心五条内置命令](/adr/0106-core-five-builtin-commands) | 将命令面板和输入框 `/` 菜单冻结为五条第一方命令 |
| [ADR 0108：移除内置交互式终端](/adr/0108-remove-built-in-interactive-terminal) | 工作面板不再承载 PTY；交互式 shell 由外部终端承担，Agent Bash 保持非交互式 |
| [ADR 0128：瞬时 provider 故障的有界重试](/adr/0128-bounded-transient-provider-retry) | 为瞬时 provider 故障共享一个有界重试预算，跨请求设置和流式传输阶段共用四次重试 |
| [ADR 0131：大段 Composer 粘贴写入会话临时目录](/adr/0131-large-text-paste-session-reference) | 超过可配置阈值的纯文本粘贴保存为会话临时文件，并在原位置插入内联 `@` 引用 |
| [ADR 0136：保留的会话面板](/adr/0136-retained-session-panes) | 最近访问的会话各自保留一个已挂载的面板（上限三个），切换是可见性交换而不是重建转录 |

## 什么时候看 ADR

- 规格告诉你系统应该怎样工作。
- ADR 告诉你为什么选择这个边界，以及哪些替代方案被放弃。
- 决策日志记录更细的冻结条款和后续修订。

前往 [英文 ADR 索引](/adr/README) 查看完整记录，或打开 [中文决策日志](/zh-CN/spec/08-meta/decisions-log) 按编号检索。
