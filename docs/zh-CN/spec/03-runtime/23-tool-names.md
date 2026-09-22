# 23. 工具名契约

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/23-tool-names) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

> 已应用的决策：D618

## 0. 冻结政策总结

| 主题 | 决策 |
|---|---|
| 模型可见名 | 小写 `snake_case`（`read`、`bash`、`task_wait`），由 `CANONICAL_TOOL_NAMES` 枚举 |
| 显示名 | 界面保留首字母大写形式（`Read`、`Bash`），并由规范名映射得到 |
| 存储中的名字 | 转录本、审计行与已保存配置保留写入时的拼写；读取时归一化 |
| 第三方名字 | `plugin_*`、`mcp_*` 与 MCP 自报的名字绝不改写 |
| 未知名 | 原样返回；归一化不失败、不猜测 |
| 契约归属 | `crates/host-core/src/tools/names.rs` 与 `packages/shared/src/tool-names.ts` |

## 1. 规范名

模型可见的工具名就是工具在协议上的身份：模型在工具调用里发出它，权限规则用它匹配，
subagent 工具集用它声明，转录本用它存储。pi 运行时在 `extractFileOpsFromMessage` 这类
辅助函数里按自己的小写名分支；拼写不同的名字就是 pi 不认识的名字。

| 旧拼写 | 规范名 | 说明 |
|---|---|---|
| `Read` | `read` | 与 pi 同名 |
| `Write` | `write` | 与 pi 同名 |
| `Edit` | `edit` | 与 pi 同名 |
| `Bash` | `bash` | 与 pi 同名 |
| `Grep` | `grep` | 与 pi 同名 |
| `Glob` | `glob` | pi 提供的是 `find` / `ls`；此处只改字母大小写 |
| `Task` | `task` | |
| `TaskWait` | `task_wait` | 多词名统一使用 `snake_case` |
| `TaskList` | `task_list` | |
| `TaskStop` | `task_stop` | |
| `Skill` | `skill` | |
| `BrowserPreview` | `browser_preview` | |
| `GenerateImages` | `generate_images` | |
| `Review` | `review` | |
| `EnterPlanMode` | `enter_plan_mode` | |
| `EnterGoalMode` | `enter_goal_mode` | |
| `SubmitPlan` | `submit_plan` | |
| `SubmitGoal` | `submit_goal` | |
| `asktool` | `asktool` | 已是小写；本次决策不改动 |
| `new_context` | `new_context` | 已是小写；本次决策不改动 |

该表是迁移范围，而不是"今天已经在发出"的清单。表外的工具名——`PluginCheck`、
`PluginScaffold`、`PluginPack`，以及 MCP 服务自报的名字——在进入该表之前保持现有拼写。

## 2. 归一化边界

两种语言暴露同一个纯函数，都不做 I/O。

```rust
pub const CANONICAL_TOOL_NAMES: &[&str];
pub fn normalize_tool_name(name: &str) -> std::borrow::Cow<'_, str>;
```

```ts
export const CANONICAL_TOOL_NAMES: readonly string[];
export function normalizeToolName(name: string): string;
```

语义：

- 规范名原样返回，因此该调用是幂等的；
- 已知旧名在任意大小写变体下都返回其规范名（`Read`、`READ`、`rEaD` 都解析为 `read`）；
- 其它名字——`plugin_*`、`mcp_*`、MCP 自报名、`PowerShell` 这类 shell id、空串或未知串
  ——一律原样返回。未知名不是错误；
- 大小写只按 ASCII 比较，因此两种实现在非 ASCII 名字上不可能出现分歧。

归一化只发生在**读入**方向。存储或配置中的名字在被读取处翻译，而不改写存储：已有转录本、
审计行、deny/allow 规则、插件清单和 subagent 工具白名单保持原有字节，旧数据无需迁移即可继续
使用。

## 3. 必须应用归一化的位置

每一处在重命名之前写入、或由用户与第三方提供的工具名读取：

1. 转录本与会话历史读取，包括压缩的文件操作收集、delegation 历史、工具结果分层与系统转录本；
2. 权限规则中 `deny` 与 `allow` 条目的匹配；
3. subagent 工具白名单与工具集合判定；
4. 插件与 MCP 工具清单的"是否内置"判定——它们保留自己的名字，但以规范名参与该判定；
5. 从外部归档导入会话时写入的工具名；
6. 计划 / 目标模式切换的工具集合。

写入路径一律写规范名，因此新落盘的数据不需要归一化。

## 4. 契约的验证方式

| 守卫 | 覆盖范围 |
|---|---|
| `cargo test -p host-core names` | Rust 实现、别名表、幂等性以及原样返回的名字 |
| `pnpm --filter @pi-desktop/shared test` | TypeScript 镜像实现，使用同一份用例表 |
| `node --test apps/desktop/test/tool-names-sync.test.mjs` | 两侧名字列表、别名表与用例表必须完全一致 |

同步测试读取两侧源码，因此只在单侧新增名字就会失败。它比较的是表格而不是行为：行为由各自
实现旁边的单元测试钉住。
