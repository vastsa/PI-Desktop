# 01. 安全

> **翻译说明：** 本页是与 [英文源规格](/spec/05-security/01-security) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


> 语言：英语（根据 ADR 0009）。状态反映了截至目前的实施情况
> M5 硬化。交叉引用：[日志记录](/zh-CN/spec/03-runtime/09-logging-and-observability)
> · [进程模型](/zh-CN/spec/03-runtime/07-process-model) · [插件安全](/zh-CN/spec/07-plugins/04-plugin-security)

## 1. 安全目标

1.渲染器绝不能获得不受限制的系统访问
2. 保护提供商 API 密钥
3. 限制代理工具执行的影响范围
4. 保持敏感操作可审计

## 2. Electron 基线

必需（全部**已实现**）：

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true` — preload 是一个完全捆绑的 CJS 文件，没有运行时
  模块分辨率，由 `test:e2e:boot` 进行端到端验证
- 无远程模块（Electron ≥ 14 默认值）
- 导航锁定：`setWindowOpenHandler` 否认并转发至
  操作系统浏览器； `will-navigate` 阻止所有非开发服务器导航
- 预加载仅公开经过白名单检查的 ADR/../03-runtime/09-logging-and-observability.md 桥
  （`IPC_WHITELIST` 在 preload 和主侧均强制执行）

### 内容安全政策

- 开发者：`script-src 'self' 'unsafe-inline' 'unsafe-eval'`（Vite要求
  HMR 工具），本地主机 websocket connect-src。字体仅限于
  `'self'` 和 `data:`，因此 Vite 内联的 KaTeX WOFF2 资源无需渲染即可渲染
承认远程字体来源。
- 生产版本：`'unsafe-eval'` 和 localhost connect-src 被剥离
  在构建时（`electron.vite.config.ts` 中的 `tightenCsp` 插件）；
  仅限 `connect-src 'self'`。提供商网络流量发生在 Node 中
  sidecar，从未在渲染器中。
- 助理美人鱼图不会扩大 CSP 或渲染器权限。只有一个
  完成的答案栅栏可以动态加载捆绑的本地渲染器。
  美人鱼与 `securityLevel: strict` 一起运行，受保护的 security/theme/limit
  配置、禁用 HTML 标签、20,000 个字符的源限制以及
  500 边限制。其生成的 SVG 然后通过 DOMPurify 的 SVG 配置文件；
  链接、URL 属性、`foreignObject`、脚本、嵌入媒体和外部
  图像元素在 SVG 到达 DOM 之前被删除。无效或
  过大的输入无法关闭转义源文本。

### 未来强化（跟踪、MVP 后）

- 封装时 Electron 熔断器（`runAsNode`、`nodeCliInspect` 关闭）
- 自动安全 e2e 中的 `webSecurity` 断言

## 3. 秘密

- 通过 Electron `safeStorage` 加密存储的密钥，由 host-core 管理
  （参见 [14 个密钥存储](/zh-CN/spec/03-runtime/14-secrets-storage)）
- UI 仅显示 configured/not-configured；从不重复关键材料
- 日志绝不能包含秘密：记录器编辑（键名模式+
  `sk-` 样式标记模式）位于 Electron main 中，`redact_value` 位于 host-core 中
  审计写入；通过无秘密泄漏烟雾检查验证
- 错误消息不得回显完整按键

## 4. 工作区沙箱

- 文件工具默认仅限于项目根目录；明确的路径
  在会话工作空间之外和临时根目录需要主机权限
  `03-runtime/03-tools-and-permissions.md` 中描述的决策
- host-core 中的路径规范化 + 根边界检查
  （`workspace::tests::blocks_escape` 涵盖逃跑尝试）
- 根目录之外的符号链接目标在可检测到时会被拒绝，除非
  显式路径已获得主机权限层批准

Plan 本身并不是工作区安全边界。主机核解决了
每个 `tools.execute` 调用的持久会话模式并应用 Plan 矩阵
在权限模式、授予、插件风险或 renderer/sidecar 状态之前。 Plan
拒绝 Write/Edit/plugin/unknown 工具，而 BrowserPreview 是显式的
只读 UI 检查异常。 Bash 在 Plan 中仍然可用：询问并
接受编辑提示，自动运行而无需确认，并且可能会改变
工作区或临时目录。用户界面必须说明这种权衡。 `SubmitPlan`
在新的唯一 `<workspaceRoot>/.pi/plan/*.md` 中保留精确的 Markdown 字节
通过 host-core 文件，验证根内工件路径，计算 SHA-256
和字节大小，然后才创建 `plan_approvals` 记录
结构化 title/question 字段。 Renderer 和 sidecar 状态无法写入或
替换一个工件。

## 5. 命令执行

- Bash默认需要确认（风险分级权限卡）；在
  Agent 或 Plan，显式 Auto 可以在不确认的情况下运行它
- Bash 协议名称保持稳定，但 host-core 选择目录 shell
（`windows-powershell`、`cmd`、`git-bash` 或 `bash`）来自持久化
  `defaultCommandShell` 受平台支持。设置写入拒绝
  unavailable/wrong-platform ID。如果一个坚持的选择后来变成
  不可用，目录分辨率故意回退到第一个
  可用的平台外壳；每转引脚其有效 ID/dialect 和
  主机在生成前使用 `COMMAND_SHELL_CHANGED` 拒绝更改的引脚。
- 超时是强制性的：默认为 60 秒，可覆盖 1-300 秒。输出
  作为单独的 stdout/stderr 通道进行流传输，并被截断为 96KB / 4000
  行，带有标明哪一端幸存的显式 `[truncated: …]` 标记
  （见 [16-tool-result-limits](/zh-CN/spec/03-runtime/16-tool-result-limits)）
- 用户中止和超时在工具之前关闭完整的进程树
  关闭；没有孤儿进程可以继续写入输出。
- 审计日志中记录的完整命令行（SQLite，已编辑），带有 shell ID
  和方言而不是不受信任的可执行路径或路径哈希
- Allowlist/denylist细化是有跟踪的后续
  ([03-工具和权限](/zh-CN/spec/03-runtime/03-tools-and-permissions))

## 6. 供应链

- 通过 `pnpm-lock.yaml` / `Cargo.lock` 提交锁定的依赖版本
  到仓库；升级是显式提交
- 更喜欢官方 pi 包
- Marketplace 软件包安装可远程进行。当前 SHA-256 检查
  根据目录值验证传输完整性，但签名和
  出版商出处尚未强制执行；查看插件信任限制
  在处理市场代码之前在 `07-plugins/08-plugin-signing-updates.md` 中
  值得信赖。
- 插件主要当前运行在其自己的原始 Node 内置插件中
  `utilityProcess`。代理的 `pi.*` 权限门不约束
  直接 Node 访问，因此市场插件必须被视为不受限制
  用户特权代码，直到实现功能沙箱。

## 7. 应用程序更新安全性（D120）

- Electron 主要拥有 `electron-updater`；渲染器 IPC 无法提供或
  覆盖修复的 HTTPS GitHub owner/repository 或发布 URL。
- 更新程序强制使用 `allowPrerelease = false`，因此发现始终使用
  GitHub 的最新稳定版本而不是同通道预发布 pin。
- Feed 清单将工件与电子构建器哈希绑定。一个错误，
  无法安装提要、哈希不匹配或无效的更新程序状态。
- 打包的 macOS 仅供手动使用：它检测释放并打开固定的
  发布页面，但从未在应用程序中下载或安装它。启用签名
  macOS 应用内渠道需要稍后的明确决策和资格。
- D126 标签版本发布 Windows NSIS 和 Linux AppImage 安装程序以及
  他们的更新清单，激活那些应用内通道。平台签约、
  回滚和分阶段推出资格仍处于发布后续阶段。
- 客户端不携带 GitHub 令牌。私人或其他无法访问的提要
  关闭失败；自动故障保持在环境状态，显式检查会暴露
  错误。
- 双区域设置产品“新增内容”文本 (D164) 在 Main 中从
  已发布变更日志目录并附加到 `UpdateState.releaseNotes`。的
  渲染器无法提供注释 URL、提要或远程主体；缺少目录
  条目只是省略了该部分。
- 开发者 ID + 公证通道仍记录在
  [发布运行手册](/zh-CN/spec/06-delivery/06-release-runbook)。

## 8. 主机进程攻击面

- host-core 在 stdio 上向 Electron 主进程讲述 NDJSON JSON-RPC
  仅；它不绑定任何网络端口
- 代理 sidecar 仅通过主进程到达主机服务
  代理 (`host.proxy`)，强制执行 **方法白名单**
  （`tools.execute`、`tools.list`、`session.get`、`session.appendMessage`、
  `workspace.get`、`app.health`) — sidecar 无法获取机密或
  通过代理改变 providers/settings/plugins
- host-core子进程（Bash工具）以用户权限运行；
  遏制依赖于权限层、目录身份、进程组/
  作业树关闭和工作区沙箱而不是操作系统沙箱

## 9. 威胁模型（总结）

| 威胁 | 缓解措施 |
|---|---|
| 渲染器中的恶意网页内容 | 无 Node、沙箱、导航锁、CSP |
| 即时注入破坏性工具的使用 | 主机拥有的持久模式策略、权限确认、路径边界、秘密隔离 |
| 依赖性中毒 | 锁定文件、几个 dep、本机模块审查 |
| 恶意本地插件 | 声明的权限、无秘密访问、MVP 后跟踪的进程隔离 (ADR 0008) |

## 10. 安检门

1. Renderer 不能 `require('fs')`（沙箱 + 无节点集成） — 已验证
2. Plan Write/Edit/plugin 调用不能在任何权限模式下运行；重击是
   在 Ask/Accept 编辑下确认，并且只能在不确认的情况下运行
   显式自动
3.在工作区外写入失败——已验证（主机测试）
4. 默认情况下，API 密钥永远不会以明文形式出现在 exports/logs 中 — 已验证
5. 非白名单的 IPC 通道被拒绝 — 已验证 (M1)
6. 伪造的renderer/sidecar模式无法覆盖持久主机会话模式
7. Plan 工件 bytes/path/hash/size 经过主机验证；批准是
approve/reject-only 和计划的 Plan 在 artifact/queue 工作之前被拒绝
8. Plan 过期、拒绝、主机重启和过时响应永远不会重播
   pending/queued/running 工作；经批准的中断会离开会话 Agent
9. 无效的设置和过时的 shell ID/dialect 无法关闭； Bash 输出流
   单独和 timeout/abort 杀死完整的进程树
