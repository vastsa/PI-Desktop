# 15. 工作区忽略规则

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/15-workspace-ignore-rules) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. Goal

通过以下方式防止工具进入 scanning/reading/writing 敏感或无用路径
默认情况下，同时允许在执行任务时进行明确的、可见的权限决策
故意以会话工作区之外的路径为目标。

## 2. 规则层（优先级高→低）

1. **安全拒绝列表**（始终开启，不在 MVP 中由用户禁用）
2. **应用程序默认设置**（已发货）
3. **工作区规则**（工作区根目录下的 `.pi-desktopignore`）
4. **用户全局忽略**（`<data_dir>/ignore`，默认即 `~/.pi-desktop/ignore`）
5. 显式工具路径仍受安全拒绝名单和
   外部路径权限门

`Glob`/`Grep` 的显式 `path` 参数会让遍历跳出第 2–4 层（与它已经绕过上层
`.gitignore` 规则的方式相同），因此显式点名 `node_modules/pkg` 或 `dist` 的
调用者仍然可以搜索它们。第 1 层对每一次遍历和每一个显式路径都生效。

## 3. 安全拒绝名单（始终）

默认情况下，工作空间外 read/write/search 被拒绝。明确的
Goal/scanning/reading/writing/MVP/`.pi-desktopignore`/`~/.pi-desktop/ignore` 路径只有在主机申请后才能继续
权限模式：`auto` 允许，而 `ask` 和 `accept-edits` 询问
用户。隐式递归遍历永远不会获得工作空间外部的访问权限。

在工作区内（以及 scratch 目录或已批准的外部根目录内）还拒绝以下内容：
- `.git/objects/**`
- 私钥模式：`*.pem`、`*.key`、`id_rsa`、`id_ed25519`
- `.env`、`.env.*` —— 但文档变体 `.env.example`、`.env.sample` 和
  `.env.template` 除外，它们不含密钥，而且通常正是编码任务需要的
- 凭证文件：`*.p12`、`*.pfx`、`credentials.json` (Google)、带有令牌的 `.npmrc`（尽力而为）

文件名匹配不区分大小写。`Glob` 和 `Grep` 会静默地把命中的文件从结果中丢掉；
显式的 `Read`、`Write` 或 `Edit`（包括 `Edit` 的移动目标）以
`WORKSPACE_PATH_DENIED` 失败，外部路径授权也不会解除这一拒绝。`Bash` 不做
过滤（§6）。

> 后续版本中 Read 可能在明确的权限提示下被允许；MVP 一律失败关闭。

## 4. 默认忽略（应用程序）

```gitignore
.git/
node_modules/
dist/
build/
.target/
target/
.venv/
venv/
__pycache__/
.pytest_cache/
.mypy_cache/
.DS_Store
*.log
coverage/
.turbo/
.next/
.cache/
```

## 5. 工作区文件

支持：

```text
.pi-desktopignore
```

语法：与 gitignore 兼容的子集。

## 6. 工具行为

| 工具 | 忽略应用程序 |
|---|---|
| Glob | 无范围遍历：第 1–4 层过滤结果；显式 `path`：仅第 1 层 |
| Grep | 无范围遍历：第 1–4 层过滤文件集（进程内遍历器与系统 `rg` 快速路径一致）；显式 `path`：仅第 1 层 |
| Read | 命中拒绝名单的文件返回 `WORKSPACE_PATH_DENIED`；否则当显式路径在外部时权限门控；拒绝后 `TOOL_DENIED` |
| Write/Edit | 命中拒绝名单的文件或移动目标返回 `WORKSPACE_PATH_DENIED`；否则当显式路径在外部时权限门控；拒绝后 `TOOL_DENIED` |
| Bash | 路径沙箱仍然由主机强制执行；忽略文件不会扩展 bash 权限 |

## 7. 诊断

工具应返回稳定的错误：
- `PATH_OUTSIDE_WORKSPACE` — 在做出外部路径权限决策之前，路径逃逸了
  工作区根目录
- `TOOL_DENIED` — 外部路径权限被拒绝、超时或取消
- `WORKSPACE_PATH_DENIED` — 显式路径命中了安全拒绝名单（请参阅
  [08-错误代码 §3.3](/zh-CN/spec/03-runtime/08-error-codes)）

UI 可以选择稍后显示 Glob/Grep 的“被忽略规则隐藏”计数。

## 8. 验收标准

- [x] 外部路径在非自动模式下需要许可，并且在自动模式下允许
- [x] 默认忽略规则在 Glob/Grep 中隐藏 node_modules
- [x] 工作区忽略文件得到遵守
- [x] 无法从 MVP 中的 UI 禁用安全拒绝列表
