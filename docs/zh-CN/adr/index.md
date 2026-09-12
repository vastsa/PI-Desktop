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
| [ADR 0137：保留的会话面板](/adr/0137-retained-session-panes) | 最近访问的会话各自保留一个已挂载的面板（上限三个），切换是可见性交换而不是重建转录 |
| [ADR 0141：展开侧边栏宽度可调整](/adr/0141-sidebar-width-resize) | 展开侧边栏通过右边缘手柄调整 240–520px 宽度，并持久化首选值 |
| [ADR 0142：允许非回环 HTTP MCP 端点](/adr/0142-allow-non-loopback-http-mcp) | 支持局域网 MCP，并明确提示明文连接风险，插件仍受网络白名单约束 |
| [ADR 0145：发布本机 macOS Intel 工件](/adr/0145-native-macos-intel-release-lane) | 通过匹配的 macOS 原生运行器发布 arm64 与 Intel x64 DMG/ZIP，两个架构工件均带有明确后缀，并合并更新源 |
| [ADR 0148：明确禁用应用快捷键](/adr/0148-explicitly-disable-keyboard-shortcuts) | 缺少覆盖使用默认值，`null` 表示未绑定并关闭渲染器、菜单和启动器分发 |
| [ADR 0174：宿主代发的插件补全与会话上下文](/adr/0174-plugin-host-owned-completion-and-session-context) | 插件可通过公开 API 列出已登录模型、读取进行中工具会话，并由宿主代打一次性补全 |
| [ADR 0175：解释安静的进行中回合](/adr/0175-live-agent-activity-status) | 用安静间隔状态行说明停顿（已被 0198 扩展） |
| [ADR 0176：按供应商覆盖 User-Agent](/adr/0176-per-provider-user-agent) | 每个 AI 服务/OAuth 行可设置可选 User-Agent（已被 0178 的 headers 映射取代） |
| [ADR 0177：用户可配置的出站代理](/adr/0177-user-configurable-outbound-proxy) | 设置里的系统/直连/自定义代理覆盖模型请求、市场、更新和内置浏览器 |
| [ADR 0178：按供应商自定义 HTTP 请求头](/adr/0178-per-provider-custom-headers) | 每个 AI 服务/OAuth 行可在高级选项中编辑任意非敏感请求头 |
| [ADR 0179：从本地智能体存储导入模型配置](/adr/0179-import-model-configuration) | 设置 → 导入显式扫描 Claude Code / Codex / OpenCode / Pi 的提供商配置并复制 API 密钥 |
| [ADR 0180：自定义全局文字缩放](/adr/0180-custom-reading-font-size) | 设置外观按比例缩放全部界面文字，不使用 px，窗口缩放仍独立 |
| [ADR 0181：主进程拥有的文件选择能力](/adr/0181-main-owned-picker-capabilities) | 文件选择路径留在主进程，以一次性令牌保护导入边界，并移除不支持的文件夹选择 |
| [ADR 0182：繁体中文应用程序壳](/adr/0182-traditional-chinese-shell-locale) | 提供独立的繁体中文外壳、系统语言解析和发版日志目录 |
| [ADR 0183：P0 国际化应用程序壳语言](/adr/0183-p0-international-shell-locales) | 提供德语、西班牙语和法语完整外壳目录及发版日志 |
| [ADR 0184：输入框工具栏中的上下文用量检查器](/adr/0184-composer-context-usage-inspector) | 把剩余容量检查器移到模型选择器左侧，答案下方只保留模型徽章 |
| [ADR 0185：韩语应用程序壳](/adr/0185-korean-shell-locale) | 提供完整韩语外壳、系统语言解析和韩语发版日志目录 |
| [ADR 0186：用宿主一次性补全总结首轮会话标题](/adr/0186-session-auto-title-summary) | 首轮提示先显示回退标题，结束后由主进程按会话模型生成摘要 |
| [ADR 0187：按焦点区分任务和交互式本机通知](/adr/0187-focus-aware-native-task-notifications) | 任务横幅仅在窗口失焦时出现；交互询问可通知聚焦的其他会话。字段名为 `kind` |
| [ADR 0188：模型配置导入保留不同凭据](/adr/0188-preserve-distinct-import-credentials) | 同一端点的不同 API 密钥作为独立提供商导入，相同凭据仍保持幂等跳过 |
| [ADR 0189：父级终态错误中止残留委托](/adr/0189-parent-fatal-error-aborts-leftover-delegates) | 父级空闲仍不中止委托；429 等终态错误会中止残留子智能体，让“继续”不再 AGENT_BUSY |
| [ADR 0190：宿主门控的大文件与拖拽文件访问](/adr/0190-host-gated-large-file-and-drop-access) | 大文件范围读取与拖拽文件授权统一经过宿主权限网关，授权只覆盖单个文件且仅存于当前插件进程 |
| [ADR 0191：明确标注两个 macOS 发布架构](/adr/0191-label-both-macos-release-architectures) | macOS DMG/ZIP 统一使用 `-arm64` / `-x64` 后缀，更新源 URL 与校验和保持一致 |
| [ADR 0192：为已配置模型设置别名并允许复制模型 id](/adr/0192-model-alias) | 别名只用于展示；配置页模型 id 可选择复制，请求仍使用真实 id |
| [ADR 0193：上下文检查器按最后一次请求计算占用](/adr/0193-last-request-context-occupancy) | 占用、本轮合计和缓存读写取最新一条助手消息，不再把工具循环里的每次请求加总 |
| [ADR 0194：可选的子智能体思考覆盖](/adr/0194-subagent-thinking-parameter-omission) | 子智能体可继承、显式关闭或不发送思考参数 |
| [ADR 0195：视口固定的工作面板开关](/adr/0195-viewport-fixed-work-panel-toggle) | 非设置页右上角提供与 Cmd/Ctrl+J 等价的指针开关 |
| [ADR 0196：在进行中重试行显示 provider 原因](/adr/0196-retry-cause-in-active-turn-status) | 悬停或聚焦重试状态行时显示错误摘要、错误码和安全的 provider 消息 |
| [ADR 0197：发布 Windows 免安装便携版](/adr/0197-windows-portable-exe) | Windows x64 通道额外发布 Portable exe，安装程序仍走应用内更新 |
| [ADR 0198：为每个安静间隔命名活动行](/adr/0198-quiet-interval-activity-phases) | 补齐 starting / preparing / compacting / recovering，并在等待 Subagent 时展示各自的粗粒度动作 |
| [ADR 0200：宿主拥有的插件会话导入与归属 API](/adr/0200-plugin-owned-session-api) | 插件历史会话由主机生成 id，并按插件、来源和外部 id 归属 |
| [ADR 0201：显式插件项目 id 与宿主拥有的会话刷新](/adr/0201-plugin-project-ids-and-session-refresh) | 插件可显式绑定主机项目，成功写入由主机通知渲染器刷新 |
| [ADR 0204：未签名 macOS 首次启动助手](/adr/0204-unsigned-macos-first-launch-helper) | 只清理 PI-Desktop 的 quarantine 属性，并用 Finder 一键启动可信的未签名应用（由 ADR 0232 修订） |
| [ADR 0232：macOS DMG 只保留打开说明](/adr/0232-macos-dmg-text-only-opening-guidance) | DMG 只显示“如果打不开请看”说明，ZIP 保留首次启动助手 |

## 完整索引

与英文 [ADR 索引](/adr/README) 逐条对应，编号、顺序与状态保持一致；状态以英文记录为准。

| 编号 | 标题 | 状态 |
|---|---|---|
| 0001 | [Electron 桌面壳](/adr/0001-use-electron) | 已接受 |
| 0002 | [使用 pi Agent Harness 作为内核](/adr/0002-use-pi-agent-harness) | 已接受 |
| 0003 | [混合运行时 — Rust host core + Node pi agent sidecar](/adr/0003-agent-in-main-process) | 部分被取代 |
| 0004 | [MVP 中不提供远程 Gateway](/adr/0004-no-gateway-in-mvp) | 已接受 |
| 0005 | [本地插件系统](/adr/0005-user-installable-plugin-system) | 已接受 |
| 0006 | [推迟插件市场；先构建本地插件运行时](/adr/0006-plugin-marketplace-postponed) | 已接受 |
| 0007 | [插件分发包格式采用 .piplug（zip）](/adr/0007-plugin-package-format) | 已接受 |
| 0008 | [插件运行时以独立进程隔离为目标](/adr/0008-plugin-runtime-isolation-target) | 已接受 （目标） |
| 0009 | [English-first 全球化](/adr/0009-english-first-globalization) | 已接受 |
| 0010 | [Rust host core](/adr/0010-rust-backend-host-core) | 已接受 |
| 0011 | [冻结 host RPC、存储归属与模式默认值](/adr/0011-host-rpc-and-storage-defaults) | 已接受 |
| 0012 | [通过 pi-ai + OpenAI 兼容扩展覆盖所有 provider/模型](/adr/0012-universal-provider-model-coverage) | 已接受 |
| 0013 | [将设置导航整合为四个目的地](/adr/0013-compact-settings-directory) | 部分被 ADR 0026 取代 |
| 0014 | [采用宿主拥有的存储 schema v2](/adr/0014-host-owned-storage-schema-v2) | 已接受 |
| 0015 | [设置内容随窗口宽度响应式布局](/adr/0015-responsive-settings-content) | 已接受 |
| 0016 | [围绕保留的多项目标签组织侧边栏](/adr/0016-sidebar-organization-and-multi-project-tabs) | 已接受 |
| 0017 | [移除输入框工作区上下文栏](/adr/0017-remove-composer-workspace-context-rail) | 已接受 |
| 0018 | [让思考模式贯穿完整会话管线](/adr/0018-end-to-end-thinking-mode) | 已接受 |
| 0019 | [工作面板子系统（内嵌浏览器、git 审阅、文件浏览）](/adr/0019-work-panel-subsystems) | 部分被 ADR 0108 取代 |
| 0020 | [配置 provider 工作台](/adr/0020-configuration-provider-studio) | 已接受 |
| 0021 | [平台应用外壳](/adr/0021-platform-application-chrome) | 部分被 ADR 0025 取代 |
| 0022 | [应用更新交付](/adr/0022-application-update-delivery) | 已接受 |
| 0023 | [独立的对话会话分叉](/adr/0023-independent-conversation-session-fork) | 已接受 |
| 0024 | [输入框斜杠命令与 @ 文件引用](/adr/0024-composer-commands-and-file-references) | 已接受 |
| 0025 | [Windows/Linux 窗口不显示应用菜单](/adr/0025-menu-free-windows-linux-chrome) | 已接受 |
| 0026 | [将项目索引作为归档移入设置](/adr/0026-project-archive-in-settings) | 部分被 ADR 0036 取代 |
| 0027 | [让 pi-ai 成为模型元数据的权威来源](/adr/0027-pi-model-catalog-authority) | 已接受 |
| 0028 | [将工作面板运行时上下文限定到对话](/adr/0028-session-scoped-work-panel-contexts) | 已接受 |
| 0029 | [分离原生窗口与工作面板的调整大小归属](/adr/0029-separate-window-and-panel-resize-ownership) | 部分被 ADR 0032 取代 |
| 0030 | [回合边界上下文检查点压缩](/adr/0030-turn-boundary-context-checkpoint-compaction) | 已接受 |
| 0031 | [输入框提示行不放品牌图标](/adr/0031-icon-free-composer-prompt-row) | 已接受 |
| 0032 | [为停靠的工作面板预留原生宽度](/adr/0032-reserve-native-width-for-the-docked-work-panel) | 已接受（由 ADR 0033 与 ADR 0122 修订） |
| 0033 | [内部停靠工作面板（不扩展原生窗口）](/adr/0033-internal-dock-work-panel) | 已被 ADR 0122 取代 |
| 0034 | [将命令面板并入全局搜索](/adr/0034-merge-command-palette-into-global-search) | 已接受 |
| 0035 | [通过 preload 桥暴露操作系统区域设置](/adr/0035-surface-os-locale-via-preload) | 已接受 |
| 0036 | [将设置拆分为 AI 与快捷键两个目的地](/adr/0036-settings-ia-ai-and-shortcuts-tabs) | 已接受 |
| 0037 | [在 Electron main 中解析项目指令](/adr/0037-project-instruction-chain) | 已接受 |
| 0038 | [在 Electron main 中桥接插件声明的 MCP 服务器](/adr/0038-plugin-mcp-bridge) | 已接受 |
| 0039 | [激活插件技能并以第一方 devkit 提供插件开发](/adr/0039-plugin-skills-activation-and-devkit) | 已接受（技能交付由 D174 修订） |
| 0040 | [常驻插件服务与插件间消息总线](/adr/0040-plugin-resident-services-and-message-bus) | 已接受 |
| 0041 | [限制宿主运行时资源并解耦消息持久化](/adr/0041-bounded-host-runtime-and-persistence-outbox) | 已接受 |
| 0042 | [消息级内联审阅卡片](/adr/0042-message-scoped-inline-review-cards) | 已被 ADR 0043 取代 |
| 0043 | [消息拥有的审阅快照与受保护回滚](/adr/0043-message-owned-review-snapshots-and-rollback) | 已接受 |
| 0044 | [会话绑定的项目指令预检](/adr/0044-session-bound-project-instruction-preflight) | 已接受 |
| 0045 | [Bash 工具继承用户登录 shell 的 PATH](/adr/0045-bash-inherits-user-login-path) | 已接受 |
| 0046 | [按类别拆分的进程日志文件](/adr/0046-categorized-process-logs) | 已接受 |
| 0047 | [带精确与估算 token 来源的上下文用量检查器](/adr/0047-context-usage-inspector) | 已接受 |
| 0048 | [按回合惰性激活工具](/adr/0048-lazy-per-turn-tool-activation) | 已接受 |
| 0049 | [用保留尾部恢复自动上下文压缩失败](/adr/0049-context-compaction-failure-recovery) | 已接受 |
| 0050 | [有界的 provider 流恢复与诊断](/adr/0050-bounded-provider-stream-recovery) | 已接受 |
| 0051 | [将 host RPC stdio 与 Tokio 阻塞池隔离](/adr/0051-host-rpc-stdio-resource-isolation) | 已接受 |
| 0052 | [Plan 运行状态与审批边界](/adr/0052-plan-operating-state-and-approval-boundary) | 已被 ADR 0053 取代 |
| 0053 | [Plan checkpoint](/adr/0053-plan-checkpoint-artifact-and-execution-epoch) | 已接受待实现 |
| 0054 | [可选择的命令 shell 目录与执行身份](/adr/0054-selectable-command-shell-catalog) | 已接受待实现 |
| 0055 | [仅 Agent 模式；Chat 成为内部只读配置](/adr/0055-agent-only-mode) | 已被 ADR 0052 / ADR 0053 取代 |
| 0056 | [用户拥有的 MCP 服务器与技能，共享激活作用域](/adr/0056-extension-activation-scope) | 已接受 |
| 0057 | [权限门控的外部路径与可移植原生搜索](/adr/0057-permission-gated-external-paths-and-portable-search) | 已接受待实现 |
| 0058 | [扩展页密度与主题可读的按钮表面](/adr/0058-extensions-page-density-and-button-contrast) | 已接受 |
| 0059 | [将输入框剪贴板文件持久化到会话临时目录](/adr/0059-composer-clipboard-files-in-session-scratch) | 已接受 |
| 0060 | [在 RPC 锁下归档重新生成分支](/adr/0060-regenerate-branch-archive-under-the-rpc-lock) | 已接受 |
| 0061 | [无感知的后台上下文压缩](/adr/0061-imperceptible-background-context-compaction) | 已接受（修订 ADR 0030 / ADR 0049；第 2/4/6/7/8 条由 ADR 0064 修订） |
| 0062 | [Task 工具背后的有界子智能体](/adr/0062-bounded-subagents-behind-a-task-tool) | 已接受待实现 |
| 0063 | [全局子智能体定义的托管界面](/adr/0063-subagent-management-ui) | 已接受待实现 |
| 0064 | [与 Codex 对齐的上下文压缩](/adr/0064-codex-parity-context-compaction) | 已接受（修订 ADR 0061 / ADR 0030） |
| 0065 | [平滑的外壳布局与流式反馈](/adr/0065-smooth-shell-layout-and-stream-feedback) | 已接受待实现 |
| 0066 | [空首页直接使用底部输入框](/adr/0066-empty-home-direct-bottom-composer) | 已接受待实现（修订 D111） |
| 0067 | [受 ChatGPT 启发的空首页起始引导](/adr/0067-chatgpt-inspired-empty-home-starters) | 已被 D206 取代 |
| 0068 | [为工作面板增加键盘入口](/adr/0068-work-panel-keyboard-entry) | 已接受待实现 |
| 0069 | [让原生工具的路径错误可恢复](/adr/0069-recoverable-native-tool-path-errors) | 已接受待实现 |
| 0070 | [将输入框文件引用展示与提示序列化分离](/adr/0070-separate-composer-file-reference-display-from-prompt) | 已接受待实现 |
| 0071 | [采用受 Apple 启发的全局圆角层级](/adr/0071-apple-inspired-global-corner-hierarchy) | 已接受待实现 |
| 0072 | [增加全局插件启动器](/adr/0072-global-plugin-launcher) | 已接受待实现 |
| 0073 | [暂存下一回合输入框配置并保留停止时的吞吐](/adr/0073-next-turn-composer-configuration-and-stopped-throughput) | 已接受待实现 |
| 0074 | [插件的原生通知权限](/adr/0074-native-notification-permission-for-plugins) | 已接受 |
| 0075 | [开发插件权限上限需手动重载](/adr/0075-manual-development-plugin-reload) | 已接受 |
| 0076 | [在 host-core 中捕获 Windows 保留的插件启动器组合键](/adr/0076-windows-reserved-global-shortcut-fallback) | 已接受 |
| 0077 | [增加交互式多问题 asktool](/adr/0077-asktool-interactive-multi-question-flow) | 已接受待实现 |
| 0078 | [跨平台托盘常驻最小化](/adr/0078-cross-platform-tray-resident-minimize) | 已接受待实现（由 ADR 0117 与 ADR 0123 修订） |
| 0079 | [VitePress 文档站](/adr/0079-vitepress-documentation-site) | 已接受 |
| 0080 | [启动后预热全局插件启动器](/adr/0080-prewarm-global-plugin-launcher) | 已接受 |
| 0081 | [宿主拥有的跨平台插件面板外壳](/adr/0081-host-owned-plugin-panel-chrome) | 已接受 |
| 0082 | [本地化且随页面自适应的插件面板外壳](/adr/0082-localized-plugin-panel-chrome) | 已接受 |
| 0083 | [自定义全局界面字体](/adr/0083-custom-global-ui-font) | 已接受 |
| 0084 | [推迟新任务会话创建直到首条消息](/adr/0084-deferred-new-task-session-creation) | 已接受 |
| 0085 | [让工作面板快捷键成为开关](/adr/0085-work-panel-shortcut-toggle) | 已接受（修订 ADR 0068） |
| 0086 | [macOS 保持常规激活策略](/adr/0086-macos-regular-activation-policy) | 已接受 |
| 0087 | [用行锚定、标签校验的契约取代文本匹配 Edit](/adr/0087-line-anchored-edit-contract) | 已接受待实现（修订 ADR 0043 / ADR 0069） |
| 0088 | [插件文件访问按模式声明，删除可恢复](/adr/0088-declared-file-scope-for-plugins) | 已接受（延续 ADR 0008 D009） |
| 0089 | [主动后台子代理委托](/adr/0089-proactive-background-subagent-delegation) | 已接受待实现 |
| 0090 | [用户可配置的关闭行为](/adr/0090-user-configurable-close-behavior-close-to-tray) | 已接受待实现 |
| 0091 | [将 provider 限流路由到有界的同回合重试](/adr/0091-rate-limit-same-turn-retry) | 已接受（修订 ADR 0050） |
| 0092 | [使用插件拥有的表面与宿主窗口控制胶囊](/adr/0092-plugin-owned-panel-surface) | 已接受 |
| 0093 | [保持严格 46px 插件拖拽带与极简胶囊](/adr/0093-plugin-panel-strict-drag-band) | 已接受 |
| 0094 | [每个数据目录只允许一个桌面实例](/adr/0094-single-instance-per-data-directory) | 已接受 |
| 0095 | [用厂商账户登录](/adr/0095-vendor-account-oauth-login) | 已接受待实现 |
| 0096 | [扁平化设置目录并就近放置市场源配置](/adr/0096-flat-settings-directory-and-marketplace-context) | 已接受 |
| 0097 | [将全局默认值放在 AI 设置目的地下](/adr/0097-place-global-defaults-under-ai-settings) | 已接受 |
| 0098 | [将每个厂商 OAuth 账户视为独立的 provider 行](/adr/0098-multiple-vendor-oauth-accounts) | 已接受待实现 |
| 0099 | [为设置目录增加带标题的视觉分组](/adr/0099-titled-settings-navigation-clusters) | 已接受 |
| 0100 | [内置子智能体继承父级权限模式](/adr/0100-builtin-subagents-inherit-parent-permission-mode) | 已接受 |
| 0101 | [按模型感知的图片附件传输](/adr/0101-model-aware-image-attachments) | 已接受 |
| 0102 | [发布者拥有的插件源与 Git 托管的工件存储](/adr/0102-publisher-owned-plugin-source-and-git-hosted-artifacts) | 已接受待实现（取代 ADR 0006） |
| 0103 | [紧凑的上下文用量摘要](/adr/0103-compact-context-usage-summary) | 已接受（修订 ADR 0047） |
| 0104 | [插件贡献的工作面板视图](/adr/0104-plugin-contributed-work-panel-views) | 已接受 |
| 0105 | [将 Files 作为捆绑插件发布；Review 留在宿主](/adr/0105-files-as-a-bundled-plugin) | 已接受（终端条款已被 ADR 0108 取代） |
| 0106 | [核心五条内置命令](/adr/0106-core-five-builtin-commands) | 已接受 |
| 0107 | [让当前会话任务通知抑制原子化](/adr/0107-atomic-viewing-context-for-task-notifications) | 已接受 |
| 0108 | [移除内置交互式终端](/adr/0108-remove-built-in-interactive-terminal) | 已接受 |
| 0109 | [用操作系统关联应用打开 Files 条目](/adr/0109-open-files-with-the-os-associated-application) | 已接受 |
| 0110 | [为插件面板外壳间距契约设定版本](/adr/0110-plugin-panel-chrome-spacing-contract) | 已接受 |
| 0111 | [在操作系统文件管理器中显示 Files](/adr/0111-reveal-files-in-file-manager) | 已接受 |
| 0112 | [Agent 能力管理根目录与设置 IA](/adr/0112-agent-capability-management-roots-and-settings-ia) | 已接受 |
| 0113 | [立即持久化新任务空槽并按消息数去重](/adr/0113-immediate-empty-session-slot-and-deduplication) | 已接受 |
| 0114 | [持久化 provider 模型绑定与思考配置](/adr/0114-provider-model-bindings-and-thinking-configuration) | 已接受 |
| 0115 | [插件剪贴板历史由宿主拥有并保存在内存中](/adr/0115-plugin-clipboard-history-is-host-owned) | 已接受（于 2026-08-21 修订） |
| 0116 | [将 OpenCode Go 作为固定 provider 预设](/adr/0116-opencode-go-provider-preset) | 已接受（已修订：会话路由请求头） |
| 0117 | [原生最小化时保留 Windows 任务栏条目](/adr/0117-windows-taskbar-native-minimize) | 已接受 |
| 0118 | [队列中的提示由渲染器拥有，并在回合边界停止运行](/adr/0118-renderer-owned-queued-prompts) | 已接受 |
| 0119 | [事件驱动的子智能体超时](/adr/0119-event-driven-subagent-timeouts) | 已接受待实现 |
| 0120 | [有界的会话历史窗口](/adr/0120-bounded-session-history-windows) | 已接受 |
| 0121 | [输入框提示增强保持一次性且由主进程拥有](/adr/0121-one-shot-composer-prompt-enhancement) | 已接受 |
| 0122 | [工作面板可见时预留原生宽度](/adr/0122-reserve-native-width-while-work-panel-visible) | 已被 ADR 0151 取代 |
| 0123 | [Windows/Linux 窗口控制使用原生任务栏最小化](/adr/0123-native-taskbar-minimize-controls) | 已接受 |
| 0124 | [将临时会话绑定到独立的临时工作区](/adr/0124-temporary-session-scratch-workspace) | 已接受 |
| 0125 | [渲染器交付派生品牌标记与压缩输出](/adr/0125-renderer-derived-brand-marks-and-minified-output) | 已接受 |
| 0126 | [Agent 能力页面是一个可创作的工作台](/adr/0126-agent-capability-workbench) | 已接受 |
| 0127 | [转录布局索引与基于身份的截断](/adr/0127-transcript-layout-index-and-identity-truncation) | 已接受 |
| 0128 | [瞬时 provider 故障的有界重试](/adr/0128-bounded-transient-provider-retry) | 已接受 |
| 0129 | [子智能体空闲看门狗约束沉默而非缓慢](/adr/0129-idle-watchdog-bounds-silence) | 已由 ADR 0166 修订（看门狗不再终止） |
| 0130 | [有界的已挂载转录窗口](/adr/0130-bounded-mounted-transcript-window) | 已接受 |
| 0131 | [大段 Composer 粘贴写入会话临时目录](/adr/0131-large-text-paste-session-reference) | 已接受 |
| 0132 | [将跨显示器窗口移动归因于用户](/adr/0132-attribute-cross-display-window-moves-to-the-user) | 已接受 |
| 0133 | [使用 models.dev 作为主模型目录并以 pi-ai 回退](/adr/0133-models-dev-primary-catalog-with-pi-fallback) | 已被 ADR 0134 取代 |
| 0134 | [使用 models.dev 作为唯一模型元数据来源并保留本地快照](/adr/0134-models-dev-sole-model-metadata-source) | 已接受 |
| 0135 | [重试未修改的已编辑提示](/adr/0135-retry-unchanged-edited-prompts) | 已接受 |
| 0136 | [跨上下文压缩保留活动任务边界](/adr/0136-active-task-boundary-across-compaction) | 已接受 |
| 0137 | [保留的会话面板](/adr/0137-retained-session-panes) | 已接受（修订 ADR 0130 第 4/5 条） |
| 0138 | [子智能体对等消息](/adr/0138-subagent-peer-messaging) | 已被 ADR 0147 取代 |
| 0140 | [将三个 Peer 工具合并为一个 `Peer` 工具](/adr/0140-peer-tool-consolidation) | 已被 ADR 0147 取代 |
| 0141 | [展开侧边栏宽度可调整](/adr/0141-sidebar-width-resize) | 已接受 |
| 0142 | [允许非回环 HTTP MCP 端点](/adr/0142-allow-non-loopback-http-mcp) | 已接受 |
| 0143 | [会话标题可由用户重命名](/adr/0143-user-renamable-session-titles) | 已接受 |
| 0144 | [允许用户配置的思考级别覆盖](/adr/0144-user-configurable-thinking-level-overrides) | 已接受 |
| 0145 | [发布本机 macOS Intel 工件](/adr/0145-native-macos-intel-release-lane) | 已接受（由 D353 / ADR 0191 修订） |
| 0146 | [按边界分配外层与内层工作面板的调整大小归属](/adr/0146-separate-work-panel-and-chat-resize-ownership) | 已被 ADR 0151 取代 |
| 0147 | [子智能体协调的 A2A 协议栈](/adr/0147-a2a-protocol-stack) | 已被 ADR 0165 取代 |
| 0148 | [明确禁用应用快捷键](/adr/0148-explicitly-disable-keyboard-shortcuts) | 已接受 |
| 0149 | [平静的转录运行状态动效](/adr/0149-calm-transcript-running-status-motion) | 已接受 |
| 0150 | [内联 SVG 空首页 agent 标记](/adr/0150-inline-svg-empty-home-agent-mark) | 已被 ADR 0152 取代 |
| 0151 | [将工作面板保持在固定应用窗口内](/adr/0151-internal-work-panel-dock) | 已接受 |
| 0152 | [八帧空首页吉祥物 GIF](/adr/0152-eight-frame-empty-home-mascot-gif) | 已接受 |
| 0153 | [在转录旁为流式回复建立检查点](/adr/0153-inflight-reply-checkpoint) | 已接受 |
| 0154 | [在宿主 IO 之前显示新任务空目的地](/adr/0154-reveal-new-task-empty-destination) | 已接受 |
| 0155 | [增加智谱 / Z.AI 命名端点预设](/adr/0155-zhipu-endpoint-presets) | 已接受 |
| 0156 | [简化添加 provider 的常见路径](/adr/0156-simplify-add-provider-common-path) | 已接受 |
| 0157 | [主进程拥有的 GitHub issue 反馈](/adr/0157-main-owned-github-issue-feedback) | 已接受 |
| 0158 | [保持审批卡片聚焦并记住所选模式](/adr/0158-approval-card-focus-and-remembered-mode) | 已接受 |
| 0159 | [生成的插件设置与插件局部快捷键](/adr/0159-plugin-generated-settings-and-local-shortcuts) | 已接受 |
| 0160 | [内置区域设置注册表与可搜索的语言选择器](/adr/0160-shipped-locale-registry-and-language-picker) | 已接受（由 ADR 0182 修订） |
| 0161 | [与语言选择器一致的可搜索主题选择器](/adr/0161-searchable-theme-picker) | 已接受 |
| 0162 | [跨会话 A2A 寻址](/adr/0162-cross-session-a2a-addressing) | 已被 ADR 0165 取代 |
| 0163 | [转录文件引用渲染为可预览的芯片](/adr/0163-transcript-file-reference-chips) | 已接受 |
| 0164 | [父级 agent 跨对话协作](/adr/0164-parent-cross-conversation-a2a) | 已被 ADR 0165 取代 |
| 0165 | [撤回 A2A / Peer 协调栈](/adr/0165-withdraw-a2a-peer-stack) | 已接受（取代 ADR 0147 / ADR 0162 / ADR 0164） |
| 0166 | [由父级判断的子智能体生命周期](/adr/0166-parent-judged-subagent-lifetime) | 已接受（修订 ADR 0089 / ADR 0119 / ADR 0129；致命错误路径由 ADR 0189 修订） |
| 0167 | [由 Agent 选择的 Bash 超时](/adr/0167-agent-chosen-bash-timeout) | 已接受（修订 ADR 0054 / D190 / D273） |
| 0168 | [主进程拥有的 `openExternal` http(s)/mailto 白名单](/adr/0168-main-owned-open-external-allowlist) | 已接受（修订 ADR 0109） |
| 0169 | [插件视图的分类文件预览与实时工作区事件](/adr/0169-classified-file-preview-and-live-workspace-events) | 已接受（修订 ADR 0104 / ADR 0105 / ADR 0109 / ADR 0111） |
| 0170 | [将工作面板浏览器作为捆绑插件通过公开 CDP 交付](/adr/0170-work-panel-browser-as-bundled-plugin) | 已接受（修订 ADR 0019 / ADR 0104 / ADR 0105） |
| 0171 | [宿主拥有的已完成回合 token 历史](/adr/0171-host-owned-completed-turn-token-history) | 已接受（由 ADR 0173 修订） |
| 0172 | [受约束的聊天内图片显示](/adr/0172-contained-in-chat-image-display) | 已接受（修订 fs/read 仅工作区条款） |
| 0173 | [插件拥有的 token 用量仪表盘](/adr/0173-plugin-owned-token-usage-dashboard) | 已接受（修订 ADR 0171） |
| 0174 | [宿主代发的插件补全与会话上下文](/adr/0174-plugin-host-owned-completion-and-session-context) | 已接受（修订 D019） |
| 0175 | [解释安静的进行中回合](/adr/0175-live-agent-activity-status) | 已接受 |
| 0176 | [按供应商覆盖 User-Agent](/adr/0176-per-provider-user-agent) | 已接受（修订 ADR 0095 / ADR 0156；请求头映射已被 ADR 0178 取代） |
| 0177 | [用户可配置的出站代理](/adr/0177-user-configurable-outbound-proxy) | 已接受 |
| 0178 | [按供应商自定义 HTTP 请求头](/adr/0178-per-provider-custom-headers) | 已接受（修订 ADR 0176 / ADR 0095 / ADR 0156） |
| 0179 | [从本地智能体存储导入模型配置](/adr/0179-import-model-configuration) | 已接受 |
| 0180 | [自定义全局文字缩放](/adr/0180-custom-reading-font-size) | 已接受 |
| 0181 | [主进程拥有的文件选择能力](/adr/0181-main-owned-picker-capabilities) | 已接受 |
| 0182 | [繁体中文应用程序壳](/adr/0182-traditional-chinese-shell-locale) | 已接受（修订 ADR 0160） |
| 0183 | [P0 国际化应用程序壳语言](/adr/0183-p0-international-shell-locales) | 已接受（修订 ADR 0160 / ADR 0182） |
| 0184 | [输入框工具栏中的上下文用量检查器](/adr/0184-composer-context-usage-inspector) | 已接受（修订 ADR 0047 / ADR 0103） |
| 0185 | [韩语应用程序壳](/adr/0185-korean-shell-locale) | 已接受（修订 ADR 0160 / ADR 0183） |
| 0186 | [用宿主一次性补全总结首轮会话标题](/adr/0186-session-auto-title-summary) | 已接受 |
| 0187 | [按焦点区分任务和交互式本机通知](/adr/0187-focus-aware-native-task-notifications) | 已接受（修订 ADR 0107 / D117） |
| 0188 | [模型配置导入保留不同凭据](/adr/0188-preserve-distinct-import-credentials) | 已接受（修订 ADR 0179 / D342） |
| 0189 | [父级终态错误中止残留委托](/adr/0189-parent-fatal-error-aborts-leftover-delegates) | 已接受（修订 ADR 0166 / D328） |
| 0190 | [宿主门控的大文件与拖拽文件访问](/adr/0190-host-gated-large-file-and-drop-access) | 已接受 |
| 0191 | [明确标注两个 macOS 发布架构](/adr/0191-label-both-macos-release-architectures) | 已接受（修订 ADR 0145 / D353） |
| 0192 | [为已配置模型设置别名并允许复制模型 id](/adr/0192-model-alias) | 已接受（修订 D266） |
| 0193 | [上下文检查器按最后一次请求计算占用](/adr/0193-last-request-context-occupancy) | 已接受（修订 ADR 0047 / ADR 0103 / ADR 0184） |
| 0194 | [可选的子智能体思考覆盖](/adr/0194-subagent-thinking-parameter-omission) | 已接受待实现 |
| 0195 | [视口固定的工作面板开关](/adr/0195-viewport-fixed-work-panel-toggle) | 已接受（修订 ADR 0068 / ADR 0085） |
| 0196 | [在进行中重试行显示 provider 原因](/adr/0196-retry-cause-in-active-turn-status) | 已接受（修订 ADR 0175） |
| 0197 | [发布 Windows 免安装便携版](/adr/0197-windows-portable-exe) | 已接受（修订 ADR 0022 / D126） |
| 0198 | [为每个安静间隔命名活动行](/adr/0198-quiet-interval-activity-phases) | 已接受（修订 ADR 0175 / ADR 0186） |
| 0200 | [宿主拥有的插件会话导入与归属 API](/adr/0200-plugin-owned-session-api) | 已接受 |
| 0201 | [显式插件项目 id 与宿主拥有的会话刷新](/adr/0201-plugin-project-ids-and-session-refresh) | 已接受 |
| 0202 | [暴露有效的子智能体思考元数据](/adr/0202-effective-subagent-thinking-metadata) | 已接受 |
| 0203 | [桌面操作的本地 MCP 控制平面](/adr/0203-local-mcp-control-plane) | 已接受（由 D372 修订） |
| 0204 | [未签名 macOS 首次启动助手](/adr/0204-unsigned-macos-first-launch-helper) | 已接受（由 D406 / ADR 0232 修订） |
| 0205 | [远程 Agent 控制使用专用的 Host 边界](/adr/0205-remote-agent-control-boundary) | 已接受待实现（MVP 之后；由 D376 修订） |
| 0232 | [macOS DMG 只保留打开说明](/adr/0232-macos-dmg-text-only-opening-guidance) | 已接受（修订 D371 / ADR 0204） |
| active-turn-steering | [用 Alt+Enter 向当前回合补充指令](/adr/active-turn-steering) | 已接受 |

## 什么时候看 ADR

- 规格告诉你系统应该怎样工作。
- ADR 告诉你为什么选择这个边界，以及哪些替代方案被放弃。
- 决策日志记录更细的冻结条款和后续修订。

前往 [英文 ADR 索引](/adr/README) 查看完整记录，或打开 [中文决策日志](/zh-CN/spec/08-meta/decisions-log) 按编号检索。
