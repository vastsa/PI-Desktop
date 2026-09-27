# 15. 工作区忽略规则

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/15-workspace-ignore-rules) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. Goal

通过以下方式防止工具进入 scanning/reading/writing 敏感或无用路径
默认情况下，同时允许在执行任务时进行明确的、可见的权限决策
故意以会话工作区之外的路径为目标。

## 2. 规则层（优先级高→低）

1. **安全拒绝列表**（始终开启，不在 MVP 中由用户禁用）
2. **应用程序默认设置**（已发货）
3. **工作区规则**（`.pi-desktopignore` 或设置）
4. **用户全局忽略** (`~/.pi-desktop/ignore`)
5. 显式工具路径仍受安全拒绝名单和
   外部路径权限门

## 3. 安全拒绝名单（始终）

默认情况下，工作空间外 read/write/search 被拒绝。明确的
Goal/scanning/reading/writing/MVP/`.pi-desktopignore`/`~/.pi-desktop/ignore` 路径只有在主机申请后才能继续
权限模式：`auto` 允许，而 `ask` 和 `accept-edits` 询问
用户。隐式递归遍历永远不会获得工作空间外部的访问权限。

还拒绝在工作空间内进行以下操作：
- `.git/objects/**`（可选优化；元数据稍后可读）
- 私钥模式：`*.pem`、`*.key`、`id_rsa`、`id_ed25519`
- `.env`、`.env.*`（在后续版本中可能会允许读取，并提示权限；MVP 默认拒绝 Grep 内容导出）
- 凭证文件：`*.p12`、`*.pfx`、`credentials.json` (Google)、带有令牌的 `.npmrc`（尽力而为）

> 稍后可以在明确许可的情况下放宽确切的环境文件策略；在 MVP 中无法关闭内容搜索。

## 4. 默认忽略（应用程序）

```gitignore
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
| 全局 | 过滤结果 |
| 格雷普 | 过滤后的文件集 |
| 阅读 | 当显式路径在外部时，权限门控；拒绝后 `TOOL_DENIED` |
| Write/Edit | 当显式路径在外部时，权限门控；拒绝后的 `TOOL_DENIED` |
| 重击 | 路径沙箱仍然由主机强制执行；忽略文件不会扩展 bash 权限 |

## 7. 诊断

工具应返回稳定的错误：
- `PATH_OUTSIDE_WORKSPACE` — 路径在执行之前转义工作区根目录
  外部路径权限决策，或未经许可的兼容性调用
  到达解析器
- `TOOL_DENIED` — 外部路径权限被拒绝、超时或取消
- `WORKSPACE_PATH_DENIED` — ignore/denylist 块的保留详细代码
  （今天映射到 `PATH_OUTSIDE_WORKSPACE`；请参阅 [08-错误代码 §3.6](/zh-CN/spec/03-runtime/08-error-codes)）

UI 可以选择稍后显示 Glob/Grep 的“被忽略规则隐藏”计数。

## 8. 验收标准

- [x] 外部路径在非自动模式下需要许可，并且在自动模式下允许
- [ ] 默认忽略 Glob/Grep 中的隐藏 node_modules
- [ ] 工作区忽略文件
- [ ] 无法从 MVP 中的 UI 禁用安全拒绝列表
