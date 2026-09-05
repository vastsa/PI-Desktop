# 05. 更改清单

> **翻译说明：** 本页是与 [英文源规格](/spec/06-delivery/05-change-checklist) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


> 代理在完成工作之前必须运行一份实用的清单。
> 交叉引用：[ai-development-workflow](/zh-CN/spec/06-delivery/03-ai-development-workflow) · [e2e-test-plan](/zh-CN/spec/06-delivery/04-e2e-test-plan) · [决策日志](/zh-CN/spec/08-meta/decisions-log) · [ADR 索引](/adr/README) · [BOARD](/project/BOARD)

---

## 0. GitHub Issue 准入

当提示包含 GitHub issue URL 或本仓库中无歧义的 issue 编号时，必须在请求启动清单之前完成本门禁：

- [ ] 已获取 issue 的标题、正文、标签、评论和状态。
- [ ] 已独立核实所报告的问题（缺陷已复现或有证据；功能已确认缺失或不完整且在范围内）。
- [ ] 仅在确认问题存在之后才开始实现。
- [ ] 若问题不存在：issue 已收到核实评论，结论明确时已关闭，无法定论时保持打开。
- [ ] 确认的修复合并后：issue 已收到处理结果评论并已关闭。
- [ ] 评论使用 issue 的原文语言，并以 AI 处理标记结尾（`Handled by AI.` 或 `本回复由 AI 处理。`）。
- [ ] 未评论或关闭无关 issue。
- [ ] 未从 issue 链接推断 git push。

参见 [R5 — 先核实链接的 GitHub issue](/zh-CN/spec/06-delivery/03-ai-development-workflow#r5--先核实链接的-github-issue再回复并关闭)。

---

## 1. 请求启动清单

在为新请求编辑任何文件之前：

- [ ] 识别并保留现有的未提交工作。
- [ ] 获取 `origin/main`，并且本地 `main` 快进
  工作树是干净的。
- [ ] 专用的 `<type>/<short-description>` 请求分支和工作树是
  从更新的 `main` 提交创建。
- [ ] 请求工作树重用主结帐的工具链、包
  在安全的情况下存储、缓存和忽略本地配置。
- [ ] 保持可变、不兼容或并发敏感的环境状态
  worktree-local 并被忽略。
- [ ] 在执行开始之前，当前分支不是 `main`。

---

## 2. 影响分析

在开始实施之前，请回答以下问题：

- [ ] 此更改引入了哪些行为更改？
- [ ] 哪些规格受到影响？ （列出文件路径）
- [ ] 此更改是否触及架构边界？ （进程模型、IPC、存储、安全性、插件 API）
- [ ] 此更改是否会影响用户可见或协议可见的行为？
- [ ] 对于此更改的风险和回归是否需要进行本地验证
  范围？如果是，最小的目标检查集是多少？
- [ ] 这与哪个里程碑交付成果相关？ （M1–M6，或无）

参考[规范更新矩阵](/zh-CN/spec/06-delivery/03-ai-development-workflow#3-spec-update-matrix) 以确定所需的文档更新。

---

## 3. 规格同步清单

实施后（或同时实施）：

- [ ] 每个受影响的规范文件都会使用新行为进行更新。
- [ ] 如果架构边界发生更改：ADR 会写入或更新到 `docs/adr/` 中。
- [ ] 如果实现默认值发生更改：`decisions-log.md` 条目已更新。
- [ ] 如果基线冻结决策受到影响：基线碰撞 + 显式 ADR（非 MVP 正常）。
- [ ] 规格之间的交叉引用仍然正确（没有过时的链接）。

---

## 4. E2E / 测试文档清单

- [ ] 如果用户可见或协议可见行为发生更改：[04-e2e-test-plan.md](/zh-CN/spec/06-delivery/04-e2e-test-plan) 中的新场景或更新场景。
- [ ] 如果添加或更新了场景，它将遵循模板（ID、标题、
  前提条件、步骤、预期、规格、验收、里程碑、状态）。
- [ ] 如果添加或更新了场景，则第 8 节中的可追溯性矩阵是最新的。
- [ ] 当变更风险需要时添加或更新单元测试。
- [ ] 当 IPC/RPC 合同更改或更改时添加或更新集成测试
  跨组件回归风险使它们成为必要。
- [ ] 通过的最小必要目标本地检查或本地验证
  被评估为不必要，无需单独批准或豁免。
- [ ] 除非用户明确请求 E2E，否则不会运行 E2E 套件或命令
  验证。
- [ ] 如果用户请求 E2E 验证，则请求的套件及其结果
  都记录在移交中。
- [ ] 自动触发的远程 E2E 作业被视为合并门，但
  如果没有明确的用户请求，则不会手动调度或重新运行。

---

## 5. Git 提交检查表

- [ ] 更改是一个逻辑单元（或分为重点提交）。
- [ ] 差异中没有秘密、令牌或本地数据。
- [ ] 差异中没有 `node_modules/`、构建工件或发布包。
- [ ] 提交消息遵循常规格式：`type(scope): description`（仅限英文）。
- [ ] 紧密耦合时使用代码提交的规范更新，或纯文档的相邻 `docs:` 提交。
- [ ] `git diff --stat` 已审核 — 没什么意外的。

---

## 6. Pull/Merge 请求清单

在将请求标记为完成之前：

- [ ] 请求分支被推送到远程。
- [ ] PR/MR 以 `main` 为目标，并且仅包含请求的逻辑更改。
- [ ] PR 描述列出了受影响的规格和 e2e 场景。
- [ ] 公关自我审查清单已完成。
- [ ] 要求远程检查和审查通过。
- [ ] 使用允许的合并策略将 PR/MR 合并到 `main` 中。
- [ ] 请求工作树在合并后被删除。
- [ ] 合并请求分支在本地删除 (`git branch -d`)。
- [ ] 合并后删除远程请求分支。
- [ ] 包括适用时的问题参考（例如 `Refs #12` 或
  `Closes #12`）。

---

## 6. 1 合并清理清单

请求分支集成到`main`后立即运行，是否
合并通过 PR/MR 远程发生或在主结帐中本地发生：

- [ ] 预期的合并提交已验证是否存在于 `main` 中。
- [ ] 请求工作树是干净的 - 没有未提交或未跟踪的请求文件
  留下来。
- [ ] `git worktree remove <worktree-path>` 成功，无需强制。
- [ ] `git branch -d <type>/<short-description>` 成功（没有 `-D` 后备）
  未合并的分支）。
- [ ] `git worktree prune` 使 `git worktree list` 不再有陈旧条目
  这个请求。
- [ ] 没有删除其他代理的工作树或分支。

---

## 7. App版本发布清单（稳定标签）

每个稳定的应用程序版本凹凸/标签（D164）都是必需的。仅跳过
仅文档工作或非发布杂务。

- [ ] `packages/shared/src/changelog.ts` 有最新的第一个条目
      **同时** `en` 和 `zh-CN` 下的发行版本（无前导 `v`）。
- [ ] 突出显示跨语言环境匹配的计数；英语是真理的源泉。
- [ ] 项目符号是面向用户的简短产品注释（不是原始 PR/commit 列表）。
- [ ] 产品目录中省略仅预发布版本，除非
      产品明确为该频道提供应用内注释。
- [ ] `packages/shared/src/changelog.test.ts` 将新版本列在首位。
- [ ] `pnpm --filter @pi-desktop/shared test` 通过目录对齐。
- [ ] `README.md` 与 `README.zh-CN.md` 声明当前 `<major>.<minor>.x` 版本线，
      且不含被本次发布推翻的工具链、命令、亮点或路线图描述。
- [ ] `node scripts/check-release-docs.mjs` 通过（版本面、双语目录、
      README 版本线）。
- [ ] 文档提交位于发布分支**之前**
      `node scripts/release.mjs <version> --tag` / `git tag v<version>`。
- [ ] GitHub 自动生成的发布正文被视为仅限 Web，而不是
      应用内源（[06-release-runbook.md §4.1](/zh-CN/spec/06-delivery/06-release-runbook#4-1-强制发布版本面门禁-d164-d260)）。

---

## 8. 最终完成定义门

在将工作标记为完成之前，请验证以下**所有**内容：

| # | 门 | 来源 |
|---|---|---|
| 1 | 请求从最新的 `main` 创建的分支和工作树；在安全的情况下重复使用主要环境 | [R4 — 请求分支 + 工作树 + 合并门](/zh-CN/spec/06-delivery/03-ai-development-workflow#r4--request-branch--worktree--merge-gate) |
| 2 | Code/doc 实施计划的变更 | [开发循环]的第 4 步(03-ai-development-workflow.md#2-development-loop) |
| 3 | 所有受影响的规格均已更新 | [R1 — 规格同步](/zh-CN/spec/06-delivery/03-ai-development-workflow#r1--spec-first--spec-sync) |
| 4 | 记录 E2E 场景（或确认不需要） | [R3 — E2E 覆盖文档](/zh-CN/spec/06-delivery/03-ai-development-workflow#r3--e2e-coverage-doc) |
| 5 | 通过必要的针对性本地验证，或被评估为不必要；自动触发远程闸门通过；仅当明确请求时，代理才会运行或调度 E2E | 开发循环的步骤 7 和 11 |
| 6 | 通过常规消息提交的更改 | [R2 — 每次更改提交](/zh-CN/spec/06-delivery/03-ai-development-workflow#r2--commit-per-change) |
| 7 | 如果里程碑交付完成，则更新董事会 | 开发循环的第 9 步 |
| 8 | 提交中没有秘密或本地数据 | [§4.4 永不提交](/zh-CN/spec/06-delivery/03-ai-development-workflow#44-never-commit) |
| 9 | PR/MR 合并为 `main`；请求删除工作树和分支 | [R4 — 请求分支 + 工作树 + 合并门](/zh-CN/spec/06-delivery/03-ai-development-workflow#r4--request-branch--worktree--merge-gate) |
| 10 | 磁盘上没有留下合并的工作树； `git worktree list` 没有该请求的过时条目 | [§6.1 合并清理清单](#61-merge-cleanup-checklist) |
| 11 | 若链接了 GitHub issue：实现前已核实；以其原文语言评论并标明 AI 处理；结论明确时已关闭 | [R5 — 先核实链接的 GitHub issue](/zh-CN/spec/06-delivery/03-ai-development-workflow#r5--先核实链接的-github-issue再回复并关闭) |

如果任何一个门失败，则更改**未完成**。
