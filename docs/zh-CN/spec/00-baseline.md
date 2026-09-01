# PI-Desktop 基线冻结

> **翻译说明：** 本页是与 [英文源规格](/spec/00-baseline) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


- 基线版本：`0.4.16`
- 日期：`2026-08-14`
- 状态：`Frozen for implementation details (Plan checkpoint artifact + approval/execution startup fence + protocol v9 + schema v10 + selectable shell catalog + icon-free composer prompt row + turn-boundary context checkpoint compaction + session-scoped work panel + pi-owned model metadata + provider/runtime safety + M5 hardening + settings IA + project archive + sidebar organization + app update delivery + three-platform release + Extensions page density and theme-readable actions + custom global UI font)`
- 语言政策：**英语优先**
- 后端策略：**Rust 主机核心 + pi 代理 sidecar**

> 版本历史记录：`0.3.4` 冻结了 provider/runtime-safety 决定
> (D001–D033)。 `0.4.0` 吸收了 Codex 视觉平价决策系列
>（D034+，黄金来源=决策日志§D）和M5强化决策
>（D078–D083：签名通道、品牌图标、监督、渲染器沙箱、
> 日志通道、窗口状态）。 `0.4.1` 冻结紧凑型四目的地
> 来自 D090 / ADR 0013 的设置目录。`0.4.2` 替换冻结的 720px
> 使用窗口响应式 D092 / ADR 0015 布局设置内容上限。
> `0.4.3`采用保留多项目侧边栏选项卡，无损
> project/session 组织，以及基于会话的工具隔离
> D093 / ADR 0016. `0.4.4` 通过删除被动输入框上下文轨道
> D095。 `0.4.5` 通过冻结端到端思维水平和提供商预设
> D096/D102 和 ADR 0018。`0.4.6` 取代 D020 的一揽子延期
> 在 D120 / ADR 0022 中打包应用程序更新模式，同时保留 D010。
> `0.4.7` 通过 D126 提升了 D010 仅适用于 macOS 的发行范围：标签构建
> 发布 macOS arm64、Windows x64 的安装程序和电子更新程序源，
> 和 Linux x64。
> D285 在 arm64 通道旁增加本机 macOS Intel x64 标签通道；两个 macOS
> 架构都从匹配的运行器发布 DMG/ZIP 工件。
> `0.4.8` 将持久项目索引从主页侧边栏移至
> 通过 D133 / ADR 0026 设置为第五个 **项目存档** 目标。
> `0.4.9` 使固定的 pi-ai 目录对于已知模型具有权威性
> 元数据并通过 D136 删除桌面拥有的模型参数覆盖/
> ADR 0027。
> `0.4.10` 取代了对话开关上破坏性的工作面板清理
> 通过 D142 / ADR 0028 具有运行时会话范围上下文。
> `0.4.11` 采用回合边界模型-上下文检查点压缩
> D158 / ADR 0030，同时保留完整的可见转录本。的
> ADR 0049 中的上下文恢复修正添加了持久的保留尾部
> 自动压缩失败的后备。 D200 / ADR 0061 得出
> 来自模型窗口的预算而不是设置并删除压缩
> 设置。 D203 / ADR 0064 然后重建机制以匹配 Codex：
> 压缩仅是内联的，检查点在回合继续时只携带摘要和
> 最新的活动用户消息；已完成回合不携带裸的历史用户消息。
> 面向模型的 `new_context` 工具和两个预算提醒
> 返回，每次压缩都会添加一个记录行和一个警告，以及一个
> 无摘要翻转系列存在于内部开关后面。
> `0.4.12` 标准化了主目录和线程停靠的输入框提示行，无需
> 通过 D160 / ADR 0031 领先品牌标志，同时保留壳牌品牌
> 其他地方。
> `0.4.13` 将聊天操作配置文件替换为 Plan 操作状态
> 通过 D188 / ADR 0052。Plan 与计划状态下的 pi Agent 相同，保持
> 权限模式选择，将 Bash 暴露于该策略，否认
> Write/Edit/plugin 工具，并通过单独的提交结构化计划
> 主机拥有的批准过渡。主机协议为v7，存储架构
> v8；保留的聊天值会迁移到 Plan，而 Agent 仍保留默认值。
> `0.4.14` 用不可变的主机编写的 Markdown 替换该提案
> `<workspaceRoot>/.pi/plan/*.md` 至 D189 / ADR 0053 下的检查点。
> SubmitPlan 接受标题、Markdown 和问题； Markdown 字节是
> 完全保留，而 title/question 仍保留结构化审批字段。
> 仅在默认显式权限选择的情况下才批准 approve/reject
> 询问，然后打开工件进行审查。待处理、排队和正在运行的工作
> 被启动进程栅栏中断而不重放，而
> 已批准的会话仍为 Agent。 ADR 0054 添加可选择的 shell
> 目录，同时保留 Bash 协议名称。主机协议是 v9 并且
> 存储架构是 v10。
> `0.4.15` 通过 D196 / ADR 0058 修改了 D169 扩展演示：
> 删除了四张数字概览带，并共享按钮表面
> 使用语义主题标记，以便主要和次要操作在
> 深色和浅色主题。主机协议或存储架构没有更改。
> `0.4.16` 通过 D232 / ADR 0083 增加了用户可选的全局界面字体：
> 设置「外观」卡片新增可搜索的字体选择器；选择结果持久化为
> `AppSettings.fontFamily` 并覆盖 `--font-sans`。四款开源
> （SIL OFL 1.1）字体——Geist、Inter、Noto Sans SC 和 LXGW WenKai——
> 随应用本地发布并附带许可证文本，系统已安装字体由 Electron
> 主进程通过新增的白名单通道 `pi-desktop/app/systemFonts` 枚举。
> 主机协议或存储架构没有更改。

## 冻结的决定

1.产品名称：**PI-Desktop**
2. 桌面外壳：**Electron**
3. 用户界面：**React + TypeScript + Vite + Tailwind**
4. UI语言默认：**英语**
5. 文档/问题/提交语言：**英语为主**
6. Agent 引擎：**pi (`pi-ai` + `pi-agent-core`)**
7.后端主机核：**Rust**
8. Agent循环位置：**Node/TypeScript pi sidecar**（不是渲染器）
9. Electron主要作用：**瘦编排器**
10. 桥： **preload IPC 仅适用于渲染器**
11. 主机服务传输：**Rust sidecar + stdio JSON-RPC (NDJSON)**
12. 存储所有权：**Rust host-core 独家拥有 SQLite**
13. MVP 域：**本地编码代理**
14.默认模式：**Agent**
15. 产品操作选择器：**Agent | Plan**；内部 `page = "chat"`
    值仍然是对话表面的实现细节，而不是
    操作模式
16.Agent 工具：**读取/Glob/Grep/写入/编辑/Bash**
17、权限超时：**120s→拒绝**
18. 会话授予范围：**按工具名称**
19. `~/.pi` 自动导入：**不在 MVP 中**
20.不在MVP中：**网关/远程WebUI控制**
21.扩展模型：**用户可安装的插件系统**
22.插件第一阶段：**命令/面板/代理工具/技能**
23.插件运行时目标：**单独进程**； M4 可以使用主机管理的沙盒运行时
24. 插件市场：**协议已定义，实施推迟**
25.插件包格式：**`.piplug`(zip)**
26.插件信任第一步：**sha256校验和；稍后签名**
27. 第一个发布平台：**macOS 仅arm64** — 在 preload/D126 中提升；
    标签构建现在发布本机 macOS arm64 和 Intel x64、Windows x64 及
    Linux x64 工件
28. TS模式库：**typebox**
29. i18n 库：**i18next**
30. Bash：**非交互式、流式传输并从可选择的 shell 解析
目录;默认超时 60 秒，具有有限覆盖**
31. 新手引导：**内联检查表**
32. 可观测性 MVP：**仅限本地日志**
33.错误模型：**共享AppError代码注册表**
34. 提供商覆盖范围：**通过 pi-ai 原生 + OpenAI 兼容 + 定制实现通用**
35. 示范政策：**无封闭许可名单；可刷新的目录+自由格式的模型ID**
36. 提供程序存储：**Rust SQLite 配置 + 操作系统密钥存储引用**
37. Secrets后端：**safeStorage主+加密文件后备**
38. 工作区忽略：**拒绝列表 + 默认值 + `.pi-desktopignore`**
39. 工具结果限制：**256KB / 4000 行，带截断标记**
40.设置目录：**Basics/模型配置/Import/Project archive/Info**；
    项目档案拥有持久的项目发现、归档、恢复和
    重新开放工作流程；
    插件管理仍然是应用程序外壳的独立 **插件** 目的地
41.侧边栏组织：**保留具有本地渲染器的多项目选项卡
    project/session 固定、归档、折叠和排序元数据**
42. 项目激活：**通过现有的一个可见的主机工作区
    `project.set`；工具根仍然绑定到原始会话项目**
43. 上下文管理： **Codex 形式的 pi-native 检查点摘要 —
     确定性预请求硬防护的内联压缩；回合继续时总结
     加上最新的活动用户消息，已完成回合不携带裸历史用户消息；持久主机检查点，以及
     一次溢出重试。该模型可以通过请求一个新窗口
     `new_context`；每次压缩都会添加一行记录和一个警告。
     没有面向用户的设置**
44. Plan 工具和策略：**Read / Glob / Grep / BrowserPreview / Bash plus
    `EnterPlanMode` 和 `SubmitPlan`； Write/Edit/plugin 和
    未知工具被拒绝。 Bash 遵循 `ask`、`accept-edits` 或 `auto`，因此
    Plan 是计划意图，而不是严格的只读安全配置文件。**
45. Plan 检查点：**`SubmitPlan(title, markdown, question)` 导致 host-core
    将确切的 Markdown 字节保留在新的唯一文件中
    `<workspaceRoot>/.pi/plan/*.md` 工件，而 title/question 仍然存在
    现有 `plan_approvals` 行中的结构化字段。该行记录了
    工件 path/hash/size 和执行字段。 Approve/reject 是唯一
    行动；批准明确选择 `ask`、`accept-edits` 或 `auto`
    Ask 作为 UI 默认，打开工件进行审核，并在 30 后过期
    `PLAN_APPROVAL_TIMEOUT` 的绝对分钟数。**
46. Plan 恢复和 shell：**启动事务标记先前待处理，
    排队，并且运行 Plan 工作在服务 RPC 之前中断，没有
    重播；已批准的中断执行离开会话 Agent。
    配置仅处于空闲状态，每个会话都有一个运行轮次。
    渲染器可以在回合进行时进行最新的下一回合配置
    正在运行，但仅在主机报告空闲后才提交该选择。
    `defaultCommandShell` 选择平台目录条目；不可用
    持久化的选择会回退到第一个可用的平台 shell，每个
    将引脚变为有效 ID/dialect，主机拒绝之前的过时身份
    60 秒默认超时下的流式输出。**

## 真相来源

- 规格索引：`docs/spec/README.md`
- 导航：`docs/spec/NAV.md`
- 决策日志：`docs/spec/08-meta/decisions-log.md`
- ADR：`docs/adr/`
- 示例插件：`examples/plugins/hello`

## 交货状态

**M6 — Plan** 针对这些冻结于 2026 年 8 月 5 日实施并接受
详细信息：

1.共享Plan/session/shell合约和协议v9
2. schema v10 迁移、不可变计划工件和 `plan_approvals`
   执行 fields/startup 栅栏
3. Rust 权威的 Plan 策略、shell 身份和进程取消
4. 单代理 SubmitPlan/approval/execution 状态转换
5. 渲染器工件批准、shell 选择和 EN/zh-CN UX
6. 重点迁移、策略、流式传输、超时、恢复和渲染
   EN/zh-CN验证

冻结协议仍为 v9，存储架构仍为 v10。未来的变化
必须保留自动化 M6 场景 E2E-104 到 E2E-117 或更新
变更合同前的相关决定记录。
