# 提供商模板账号——候选验证

> **翻译说明：** 本页对应 [英文源规格](/spec/06-delivery/provider-template-validation)。命令、标识符和指纹保持原文；验证事实以英文源记录为准。

日期：2026-10-26。本记录描述未提交的请求候选，不代表发布、PR 集成结果、真实厂商认证或全套测试通过。

## 候选

- 工作树：`worktrees/plugin-model-providers`；分支：`feat/plugin-model-providers`。
- HEAD 与已获取的 main 基线：`541471d55648df021b232b5d01f0e1dd14cbb033`。
- 候选为该基线加上保留的、尚未提交的功能与审计改动。
- 对 apps/packages/crates/scripts 下 99 个已改动或未跟踪的源码／测试文件及
  `pnpm-lock.yaml`，将 `[path, SHA-256(file)]` 排序后计算的 SHA-256 为：
  `450e4ec441c861734253e6b16ef69d25b5dafe05e49a9936afafa10aec9e563d`。
  文档不参与计算，避免报告指纹自引用。
- 已构建 debug Host 的 SHA-256：
  `be1dc4b9b711f55b0716dc6afb1cabd6f84ab33c07052996983df5f0000b37a2`。
- 环境：Windows/Git Bash；Node 24.19.0、pnpm 12.8.1、Rust 1.98.1；
  复用现有工作区依赖，临时 profile 与插件子进程相互隔离。
- 未提交、未更新发布版本、未打包应用；未使用真实凭据、外部推理或付费 API，
  也未连接用户正在运行的 Desktop。

## 交付路径与关键模块

[决策](/adr/plugin-provider-template-accounts) 与
[V1 契约及示例](../07-plugins/17-provider-template-accounts.md) 定义了职责分离：
安装只增加可复用服务模板，原生设置创建由 Host 生成身份的独立账号。
官方服务与旧单例贡献继续使用原有路径。
标准 key／无认证传输及 Host 执行的 PKCE／设备码 OAuth 不需要自定义执行授权。
专有 OAuth／推理需要单独信任，并使用固定安全错误通道。

SDK `provider-template.ts`、Rust `plugins/provider_templates.rs` 与
`db/provider_templates_migration.rs`、Main `provider-template-oauth.ts` 与
`plugin-provider-source.ts`、原生 `ProviderTemplateSetupForm.tsx`、共享契约，
以及现有推理 broker／原生模型编辑器各自承担相应职责。
Schema25 保留旧数据但不自动接管。运行时账号失效处理现已覆盖图像调用与迟到结果。

## 实际执行的检查

| 检查 | 结果 |
| --- | --- |
| `pnpm build:js` | 修正历史审计报告的三个 VitePress 源码链接格式后通过；审计发现未变 |
| Desktop typecheck | 通过；最终实现后重新执行 |
| `pnpm lint` | 通过（仅配置的 Biome 范围与样式 token 检查，不代表所有源码均 lint） |
| SDK `vitest run src` | 235 项通过，仅源码 |
| Shared `vitest run src` | 656 项通过，仅源码；默认运行也通过，但将 source/dist 重复计数 |
| DevKit `vitest run src` | 53 项通过 |
| i18n 测试 | 31 项通过，覆盖九个目录，包括不支持探测的文案 |
| Agent 定向 runtime/provider/subagent/image 套件 | 488 项通过 |
| Host-runtime provider inference | 4 项通过 |
| Desktop template/plugin-provider/vendor-OAuth/chooser/default/image-default selection | 168 项通过 |
| `cargo fmt --check` | 通过 |
| Rust `providers::` | 71 项通过 |
| Rust `plugins::` | 124 项通过，1 项忽略（与 provider 过滤范围重叠，不可相加） |
| Rust `provider_template` | 6 项通过：真实 RPC、生命周期、存储、清理与迁移 |
| `cargo clippy -p host-core --all-targets --locked` | 退出码 0；仍有四条警告 |
| `cargo build -p host-core --locked` | 通过，生成 debug 候选二进制 |
| 真实 Host + 插件子进程 E2E | 1 项通过 |
| `pnpm check:pr-base`、`git diff --check` | 通过 |
| 新增本地文档链接 | 检查了 44 个，检查时无缺失目标 |
| 文档中的 JSON 模板 manifest | 已由构建后的 SDK `validateManifest` 校验 |

红绿回归还复现并修复了已完成图像调用的注册泄漏、禁用模板拒绝重新认证、
禁用或卸载后仍可解析未过期凭据、账号迟到结果的拒绝处理，以及新模板的跨语言校验缺口。
SDK manifest 以规范形式序列化整数；Rust 现有整数读取器仍拒绝非规范的浮点／指数 JSON 数字表示。
没有为适应新模板契约而放松旧校验。

## 代表性跨进程证据

```sh
node --test apps/desktop/test/provider-template-native-host.e2e.mjs
```

候选 Rust Host、数据库、加密密钥存储与真实插件子进程覆盖以下路径：
安装但不建账号 → 两个 OAuth 账号 → 独立名称、模型偏好与刷新 → 重新认证不增加第三行
→ 原生聊天与子代理补全 → 图像 scratch 输出 → 删除一个账号 → 重启
→ 保留另一个账号、凭据与偏好 → 卸载删除自有账号和密钥，但保留历史会话。
测试使用合成 OAuth 与适配器实现，不是真实提供商；未使用的工具派发仍为桩实现。

独立原生组件测试覆盖选择器、key／无认证设置与模型编辑。
声明式账号 fixture 通过合成 HTTPS 边界执行公开 OAuth 编排和真实 PKCE 回环／设备码引擎。
生命周期 fixture 覆盖取消、卸载、待清理状态与隐私；Rust RPC 测试覆盖撤权、
模板移除与恢复、敏感更新、重启及可重试的清理失败。
没有任何单个 fixture 声称覆盖完整应用窗口或真实在线服务行为。

## 完整 Host 结果与剩余阻碍

`cargo test -p host-core --locked`：**1032 项通过，18 项失败，1 项忽略**。
失败位于 `data_relocation::tests`（3）、`rpc::remote_tools::tests`（2）、
`rpc::worktree_rpc::tests`（3）、`session_worktrees::delegate::tests`（2）、
`session_worktrees::lifecycle::tests`（3）与 `session_worktrees::merge::tests`（5）。
部分实际值与期望值因 Windows CRLF 不同。这些区域在先前运行中也曾失败，
但尚未建立干净基线对照，因此本记录不认定它们与任务无关，也不宣称完整 Host 套件通过。
它们仍是全套验收阻碍。

未执行：完整 Electron 窗口验收、`verify:ui:*`、真实 Antigravity 或其他在线服务的
OAuth／协议／权益检查、付费生成、Semgrep／CodeQL 或依赖安全认证。
原生 Node 插件代码仍属于可信代码，而不是操作系统沙箱。
历史审计发现与指纹仍是历史记录，不是上述限制已消失的证据。

详细命令日志与逐文件候选指纹保留在会话 scratch 目录
（`template-final-*.log`、`template-candidate-fingerprint.json`），不作为应用遥测提交。

## PR 1897 最新主线集成复测

本节追加新候选证据，不改写上面的历史结果。任务工作树为
`worktrees/pr-1897-main-conflicts`，分支为 `fix/pr-1897-main-conflicts`。
主线基准 `5aa253883c4e34fd65d31c434256d424c352bf0b`，保留的 PR 头为
`a2fadb33795e3b41df3656524e76c1f161ac7f27`；不推送、不合并远程主线。

冲突修复同时保留下架状态、插件聊天能力和生图绑定过滤。数据库采用 schema 26，
先执行发现状态 v24→v25，再执行模板 v25→v26，兼容只有模板表的开发版 v25。
回归检查账号、合成密钥、模型配置、模板身份、会话、可读备份及重开幂等性；不使用真实数据库。

- 112 项源码／锁文件指纹：
  `8af8ea15392b59cd38e82f81edb2ffdabc54017ff408e74a34acc8478c612b45`。
- Debug Host SHA-256：
  `954d5b4da5c6b11b2c1c343a87d6fd9345acd669f44a2ead18ef419a7821d239`。
- 环境为 Windows/Git Bash、Node 24.19.0、pnpm 12.8.1、Rust 1.98.1。
  复用第三方依赖和 Electron；pnpm 自动从现有缓存建立任务本地链接，下载数量为零。
  Rust 复制依赖缓存，不共享可变 Host 编译产物。
- 通过：JS 构建、递归类型检查、lint、文档检查、agent-policy、pr-base、
  Rust fmt、Host 构建、clippy（保留 4 项已有警告）。
- 源码测试通过：shared 656、SDK 235、DevKit 53、i18n 31、Host Runtime 125
  （跳过 3）、Agent 相关套件 576、Desktop 模板／插件／OAuth／发现／Composer 170。
- Rust 过滤套件通过：`db::` 41、`plugins::` 124（忽略 1）、`providers::` 71、
  `turn_queue::` 12、`provider_template` 12。套件有交集，不应相加。
- 隔离 E2E 通过：`node scripts/e2e-model-discovery-state.mjs`，以及
  `provider-template-native-host.e2e.mjs`、`provider-template-cleanup-host.e2e.mjs`
  两项真实 Host 测试；均使用临时状态与合成服务。
- Host 全量为 **1039 通过、18 失败、1 忽略**。同工具链下的最新主线干净源码快照为
  **1007 通过、相同 18 项失败、1 忽略**：数据迁移 3、远程工具分发 2、工作树 13，
  包含 Windows 路径与 CRLF 问题。不能视作全量通过；仅进程级 autocrlf 覆盖未解决它们。
  对照后清理任务 Host 编译产物并强制重编，避免 Cargo 跨源码缓存复用。

日志与指纹位于会话临时目录，名称以 `pr1897-` 开头。未运行完整桌面窗口验收、真实服务、
付费 API 或 `verify:ui:*`。原工作树、本地主线、应用数据和根目录 `.workflow/` 保持不变。
