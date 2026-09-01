# 01. 产品范围

> **翻译说明：** 本页是与 [英文源规格](/spec/01-product/01-product-scope) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 定位

PI-Desktop 适合需要本地代理来对 read/modify 项目进行可见控制的开发人员和高级用户。

它结合了：

- 强大的桌面用户体验
- pi 代理功能
- Rust 支持的本地主机操作
- 用户可扩展的插件
- 独立的 MCP 服务器、技能和子代理

## 2. 目标用户

### 小学
- 每天使用编码代理的开发人员
- 需要本地执行file/command的用户
- pi生态系统中的用户

### 中学
- 需要自定义 providers/base URL 的团队
- 插件作者扩展工作流程

## 3. 核心场景

### A. 项目问答
打开存储库并询问 architecture/code 问题。

### B. 受控编辑
请求更改代码、审查工具调用、批准写入。

### C. 运行并诊断
运行 tests/commands，检查输出，迭代。

### D. 多会话工作
保持并行会话进行重构、调试、文档等。

### E. 自定义插件扩展
安装或开发命令、面板、工具、技能、主题的本地插件，
MCP 服务器、常驻服务和消息总线集成。

### F. 批准的计划和目标
使用 Plan 在执行前检查实施检查点，或使用 Goal
在 Agent 选择和运行之前批准结果和验收标准
步骤。

### G. 日常工作流程支持
从其他本地代理导入会话，在
输入框，使用 review/terminal/browser/files 的工作面板，管理
通知，并手动或按照记住的节奏运行预定的提示。

## 4. 当前发货范围

- 适用于 macOS arm64、Intel x64、Windows x64 和 Linux x64 发布通道的 Electron 桌面应用程序
- 英文默认UI + i18n框架
- 会议 create/switch/restore
- 多提供商配置
- 安全的 API 密钥存储
- 流输出+中止
- 工作区绑定
- 内置工具：读/写/编辑/Glob/Bash (+ Grep)
- 工具调用可视化
- 权限确认
- 具有 SQLite 索引的 JSONL 转录持久性
- Agent / Plan / Goal 具有主机拥有的批准工件的操作合约
- 工作面板：审阅、终端、浏览器和文件
- 项目存档、多项目侧边栏、会话 fork/import 和通知
- 扩展页面：本地插件、市场包、MCP、技能和
  具有激活范围的子代理
- 具有手动执行和节奏元数据的计划任务记录
- Rust 用于特权操作的主机核心骨架

## 5. 超出范围（当前阶段）

- 远程网关/浏览器远程控制
- 云账户同步
- 完整的IDE体验
- 值得信赖的插件 provenance/signatures 和原始插件的功能沙箱
  Node API
- 移动客户端
- 计费系统
- 计算机使用浏览器接管

## 6. 操作模式

| 产品选择器 | 行为 |
|---|---|
| Agent | pi Agent 在选定的权限策略下使用完整的执行工具集运行。 |
| Plan | 相同的 pi Agent 在计划状态下运行。它可以使用 Read/Glob/Grep/BrowserPreview 进行检查，在选定的权限策略下运行 Bash，使用 plan/context 控件，并调用 `SubmitPlan(title, markdown, question)`。在单独批准之前，主机核心在新的不可变 `<workspaceRoot>/.pi/plan/*.md` 工件中保留确切的 Markdown 字节； title/question 保留结构化审批字段，并且卡打开工件。 Write/Edit/plugin 工具被拒绝。 |
| Goal | 同一个 pi Agent 通过 `SubmitGoal(title, markdown, question)` 协商结果合约，在单独批准之前保留不可变的 `<workspaceRoot>/.pi/goal/*.md` 工件。批准后，它返回到 Agent 模式，并朝着规定的验收标准努力，报告其验证的标准或停止它的边界。 |

Plan 和 Goal 是合约模式，而不是严格的只读安全配置文件：Bash
在 `ask` 或 `accept-edits` 提示下运行，而 Bash 在 `auto` 下运行则无需
确认并可能会改变工作区或临时目录。模式
选择器和 SQLite/Agent 都寻址相同的 Agent；
批准将 Agent 转换为 Agent 执行，而无需创建第二个
规划师。批准仅限approve/reject，且显式执行权限
选择默认为询问。主机重新启动中断挂起、排队或
运行合同工作而无需重播；已批准的中断运行
将会话留在 Agent 中。

现有的持久 `Chat` 模式值会迁移到 `Plan`。新的会议和新的
计划任务默认为 Agent。对话界面可以继续使用
内部 `page = "chat"` 路由值；该值不是操作模式。

## 7. 成功标准

1. 5 分钟内第一次有用的聊天
2. 在实际项目上完成一次受控本地编辑
3.工具调用可读且可中断
4. 会话在重新启动后仍然有效
5. Renderer 从来没有直接的 Node/FS 权限
6. UI完全可用英文
7. 提交的 Plan 或 Goal 不能在没有单独的情况下进入执行。
   配套审批；其确切的 Markdown 字节保存在一个独特的
   `.pi/<kind>/*.md` 工件和批准行记录其路径、哈希值和
   尺寸

## 8. 命名

- 产品：`PI-Desktop`
- 包装：`pi-desktop`
- 应用程序 ID：`com.pi-desktop.app`
- 窗口标题：`PI-Desktop`

## 9. 平台策略

| 平台 | MVP | 注释 |
|---|---|---|
| macOS 苹果芯片 | 已发表 | 初级开发及验收平台； signing/notarization 仍受凭证控制 |
| macOS 英特尔 | 已发表 | 本机 x64 DMG/ZIP 发布通道；signing/notarization 仍受凭证控制 |
| Windows x64 | 已发表 | NSIS 安装程序和应用内更新通道；本土资格继续 |
| Linux x64 | 已发表 | AppImage 和 deb 包； AppImage更新通道；本土资格继续 |
