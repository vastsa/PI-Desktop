# 02. 验收标准

> **翻译说明：** 本页是与 [英文源规格](/spec/06-delivery/02-acceptance-criteria) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


> 语言：英语（根据 ADR 0009）。
> 签署状态：M1–M4 根据 `docs/project/BOARD.md` 于 2026 年 7 月 25 日接受
> 验证快照；在 [里程碑](/zh-CN/spec/06-delivery/01-mvp-milestones) 中跟踪的 M5 项目。
> 证据密钥：`auto:<script>` = 自动检查，`manual:M<n>` = 已验证
> 在该里程碑的退出审核期间，`open` = 尚未验证。

## 1. MVP 接受声明

MVP 在以下情况下通过：

> 在 macOS 上，用户可以配置模型、打开项目、完成一个
> 使用工具的权限门控任务，并在执行后恢复会话
> 应用程序重新启动。

## 2. 功能验收

### A. 应用程序启动
- [x] 应用程序启动并显示主窗口 — auto:`test:e2e:boot`
- [x] Main↔renderer 桥接工作 — auto:`test:e2e:boot`（沙盒 preload + IPC 往返）
- [x] 应用程序版本信息公开 — auto:`test:e2e:boot`（版本 + 主机协议）
- [x] 首次运行内联检查表出现在新的配置文件上 — 手册：M2

### B. 模型配置
- [x] 可以添加提供程序 — auto:`test:e2e`（提供程序 CRUD）
- [x] 可以保存 API 密钥 — auto:`test:e2e`（通过主机秘密 set/get）
- [x] 密钥在重启后仍然有效（无需重新输入）- 手册：M2（安全存储支持的存储）
- [x] 未配置模型时清除阻止消息 — 手册：M2 (`MODEL_NOT_CONFIGURED`)

### C. 会话和流式聊天
- [x] 可以创建新会话 — auto:`test:e2e`
- [x] 可以发送消息 — auto:`test:e2e`（实时模型，当提供密钥时）
- [x] Assistant 逐个令牌输出流 — auto:`test:e2e` / `e2e-agent-live`
- [x] 生成可以中止 — 手动：M2（中止→保留部分输出）
- [x] 在历史会话之间切换有效 — 手册：M2
- [x] 空闲会话可以分叉为独立会话 -
  auto:host-core + 桌面合约测试

### D. 工作区
- [x] 可以选择项目目录 — 手册：M3
- [x] UI 显示当前项目 — 手册：M3
- [x] 工具路径根据项目根解析 - auto:host-core 测试 (`workspace::tests`)

### E. 工具和权限
- [x] Plan 和 Goal 在每种权限模式下拒绝 Write/Edit/plugin 工具 —
  auto:`test:e2e:plan` E2E-105 + host-core 权限测试
- [x] Plan 和 Goal Ask/Accept 下的 Bash 提示编辑并运行而无需确认
  在显式 Auto — auto:`test:e2e:plan` E2E-105 + host-core 权限测试下
- [x] Agent 模式使用 Write/Edit/Bash 的权限策略 — 手册：M3
- [x] 权限超时（120s）变为拒绝 — 手动：M3 (D005)
- [x] Read/Glob/Grep 在项目内部工作 — auto:`test:e2e`（glob 工具）
- [x] Write/Edit/Bash 触发内联、会话范围的确认卡 — 手册：M3
- [x] 后台事件和权限请求永远不会激活或覆盖其他事件
  session — 单位：桌面权限合约；完整的用户界面手册：M5
- [x] 拒绝阻止执行 — 手册：M3
- [x] 允许将结果返回到模型和 UI — 手册：M3
- [x] 工作区之外的路径受到权限限制 — auto:host-core 测试
（外部路径 prompt/deny/allow 和自动执行）

### M6。 Plan 检查点和 shell 执行
- [x] 一个 pi Agent 拥有 Agent，规划、审批和审批后执行 —
  自动：代理运行时 + prompt/deny/allow/Plan
- [x] Goal 重用相同的主机拥有的批准管道，写入不同的
  `.pi/goal/*.md` 工件，并在 Agent 模式下恢复以验证接受情况
  标准 — auto:agent-runtime + desktop/runtime 合约覆盖范围
- [x] `EnterPlanMode` 和 UI/session Plan 选择收敛于同一状态 —
  自动：host-core CAS 测试 + `test:e2e:plan-ui`
- [x] `SubmitPlan(title, markdown, question)` 保留精确的 Markdown 字节
  独特的 `.pi/plan/*.md` 工件，使 title/question 保持结构化
  `plan_approvals`，并记录 path/hash/size — auto:`test:e2e:plan` E2E-106
- [x] 批准仅提供 Approve/Reject；批准需要明确
  默认情况下选择“询问”的权限模式 — auto:`test:e2e:plan-ui`
  E2E-106/E2E-117
- [x] 批准截止日期绝对是 30 分钟，陈旧的回复会失败
  已关闭 — auto:`test:e2e:plan` E2E-107 + host-core 过期测试
- [x] Renderer 仅保留最新的 Plan/Goal proposal/execution 快照
  当前渲染器的生命周期； `plans.pending` 仅重新水化挂起的行，并且
  渲染器重新加载后的原始截止日期，终端卡未重新水化
  渲染器重新加载后，主机重新启动不会恢复陈旧的操作 -
  auto:`test:e2e:plan-ui` 同一主机 PID/negative 重新加载断言 +
  `test:e2e:plan` E2E-108/E2E-109
- [x] Schema v7 首先到达 v8，然后使用受保护的 v8→v11 路径；这
v8→v11 迁移是一个带有 WAL 检查点和精确的原子事务
  在破坏性工作之前可读 `pi.sqlite.v8.bak`，而模式 v9 和 v10
  接收可读备份。应用程序 settings/scheduled 配置格式错误，无效
  顶级操作模式以及未知或错误平台的默认 shell 失败
  以 v8 权威模式关闭；平台有效的 shell 仍然可迁移
  暂时无法使用时。会话、成绩单、嵌套扩展模式、
  和 `plan_approvals` artifact/execution 字段保留 — auto:host-core
  迁移测试（139/139；15 个重点数据库测试）
- [x] 挂起、排队和正在运行的 Plan/Goal 工作在主机重新启动时被中断
  没有重播；已批准的中断执行离开会话 Agent —
  自动：`test:e2e:plan` E2E-108/E2E-109
- [x] Scheduled/unattended Plan/Goal 在提供商请求之前运行失败 —
  汽车：`test:e2e:plan` E2E-110
- [x] Plan/Goal 插件工具尽管风险低、赠款或自动，但仍被拒绝 —
  auto:`test:e2e:plan` E2E-105 + host-core 策略测试
- [x] Shell 目录选择保留平台有效 ID，回退到
  当以后的查找不可用时，第一个可用的平台 shell 会拒绝
  陈旧转 ID/dialect，流 stdout/stderr，强制执行 60 秒默认值
  超时，并在中止时终止进程树 — auto:`test:e2e:plan`
  E2E-112–E2E-116 + host-core 回退测试

### M6+当前产品增量
- [x] 扩展页只保留“已安装”和“市场”两个选项卡；设置 > 智能体提供独立的
  技能、MCP 和仅全局子代理页面，包含固定高度双栏/单栏、本地启用状态、项目选择
  和目录扫描 — unit/source 合同加上 E2E-100–E2E-103
- [x] 会话导入、计划任务记录、composer 文件引用和
  剪贴板文件、全局插件启动器和下一轮配置是
  由当前 E2E 目录代表 — E2E-036、E2E-059、E2E-102、
  E2E-102a、E2E-103、E2E-120

### F. 坚持
- [x] 会话在重新启动后仍然有效 - 手动：M2（SQLite 通过 host-core）
- [x] 消息历史记录已恢复 — 手动：M2
- [x] 会话删除生效 — auto:`test:e2e`
- [x] 分叉的 source/child 历史独立存在和分歧 —
  自动：host-core 测试

### G.插件系统（局部最小值）
- [x] 插件从本地目录加载 — auto:`test:e2e` (dev load)
- [x] 插件命令出现在调色板中并执行 — 手册：M4
- [ ] 插件可以打开面板（如果已声明）- 打开（ui.openPanel 是一个 toast 存根；PluginPanelHost 跟踪后 MVP）
- [x] 插件可以注册并提供至少一种代理工具 — auto:`test:e2e`（E2E-024 调度往返）
- [x] 禁用会删除命令和工具 — auto:`test:e2e`（插件禁用）
- [x] 插件异常不会使应用程序崩溃 — 手册：M4

### H. 诊断
- [x] 错误暴露稳定代码 — auto:`test:e2e`（致命路径断言）
- [x] 日志文件夹可以从应用程序打开 - 手册：M5（打开日志操作）
- [x] 秘密永远不会出现在正常流程的日志中 — auto:`test:e2e` (no-secret-leak)

## 3. 安全验收

- [x] Renderer 没有 Node 集成（沙盒、contextIsolation） — auto:`test:e2e:boot`
- [x] 无法调用非白名单 IPC 通道 — 手册：M1（preload 白名单断言）
- [x] 秘密永远不会写入普通日志 — auto:`test:e2e` + Logger/audit 编辑
- [x] 高风险工具默认需要确认 — 手册：M3
- [ ] 未经授予权限的插件无法调用 API — 打开（强制矩阵具有插件运行时隔离，请参阅 07-plugins/13）
- [x] 插件无法读取提供程序 API 密钥 — 手册：M4（插件主机服务中没有秘密）

## 4. 质量验收

- [x] 主路径上没有崩溃 — auto:`test:e2e:boot` + `test:e2e:supervision`
- [x] 错误显示可读消息 — 手册：M2（AppError 消息浮出水面）
- [x] 长输出不会冻结 UI — 手册：M3（按工具预算；搜索 128KB / 4000 行）
- [x] 按键操作显示 loading/running 状态 — 手动：M2
- [x] 发布包没有重复的 renderer/runtime 依赖树 —
  auto:desktop包合约+本机 macOS arm64/Intel x64 软件包审核：E2E-092
- [ ] 打包启动和本地 renderer/runtime 功能仍然可用
  在每个本机目标上离线 — 草案：E2E-092

## 5. 验收演示脚本

1.启动PI-Desktop
2. 配置工作模型
3.打开本地示例项目
4.问：解释一下项目结构
5.询问：修改一个无害的文件并添加注释
6. 许可卡上批准
7. 中止一代
8. 重新启动应用程序，确认会话仍然存在
9.加载示例插件，运行一个插件命令
10.禁用插件并确认命令消失

所有步骤均通过 = MVP 功能接受。

## 6. 失败处理

- 阻止：A/B/C/E/F/G 或安全中的任何故障都意味着 MVP 无法被阻止
  宣告完成。
- 非阻塞：UI 详细信息、复制、主路径外错误转到已知问题。
