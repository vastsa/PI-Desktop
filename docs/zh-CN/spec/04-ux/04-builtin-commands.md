# 04. 内置命令

> **翻译说明：** 本页与[英文源规格](/spec/04-ux/04-builtin-commands)一一对应。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

## 1. 目标

定义无需插件即可使用的五条第一方命令。它们也会出现在输入框的 `/` 菜单中。

快捷键：**Cmd/Ctrl + Shift + P**（D014）

## 2. 命令 ID 约定

```text
builtin.<domain>.<action>
```

## 3. 核心内置目录

内置 registry 有意只包含以下五条命令。插件命令会动态扩展可搜索的命令列表；
应用导航、项目管理、设置、插件管理和诊断不属于内置命令契约。

| id | 标题 | 关键词 | 类别 | 风险 | 行为 |
|---|---|---|---|---|---|
| `builtin.session.new` | 新建任务 | new、chat、task | Session | 低 | 复用当前分组最新空会话，否则立即露出空首页并创建持久空会话，然后聚焦输入框 |
| `builtin.agent.compact` | 压缩对话上下文 | compact、context、tokens | Session | 低 | 为当前空闲会话创建模型上下文检查点 |
| `builtin.mode.agent` | 切换到 Agent | mode、agent | Session | 低 | 将空闲会话模式设为 Agent |
| `builtin.mode.plan` | 切换到 Plan | mode、plan、planning | Session | 低 | 将空闲会话模式设为 Plan |
| `builtin.mode.goal` | 切换到 Goal | mode、goal、objective、autonomous | Session | 低 | 将空闲会话模式设为 Goal |

## 4. 可见性与执行规则

- 五个 ID 构成完整的第一方 registry。移除的 ID 不会出现在命令面板结果中，
  也不再有渲染器 dispatch case；插件命令仍可独立发现。
- `New Task` 使用当前项目或临时分组。若该组最新会话为空则选中复用；否则
  在第一帧露出空首页并创建持久空会话。同一分组内该操作是幂等的。
- `Compact Conversation Context` 在当前会话空闲时可用；活动回合或检查点期间
  继续遵循既有的忙碌与压缩契约。
- 模式命令使用与 Composer Agent/Plan/Goal 芯片相同的活动会话配置路径，立即更新
  空闲会话。没有活动会话时，它们更新下一个会话使用的持久化默认值；正在运行的会话
  或待审批会话不会被修改。
- `SubmitPlan` 和 `SubmitGoal` 是模型工具，不是命令面板命令。没有 Chat 模式或
  request-changes 别名。
- 原有的应用、项目、设置、插件和日志操作（仍适用时）通过各自的专用界面提供，
  但不属于命令面板或输入框的内置命名空间。

## 5. 执行结果

命令返回：

```ts
type CommandExecutionResult =
  | { ok: true; navigation?: string; message?: string }
  | { ok: false; error: AppError }
```

## 6. 验收

1. 内置 registry 恰好包含五个唯一且带前缀的 ID。
2. 命令面板搜索可匹配每条命令的标题和关键词。
3. 模式切换命令立即更新空闲会话模式；Plan、Goal 和 Agent 使用同一个 pi Agent。
4. Compact 在空闲时可用，在活动回合/检查点期间返回 `AGENT_BUSY`。
5. 被移除的 ID 以及遗留的 `newChat`、`openProject`、`openSettings` dispatch 别名，
   不会出现在 registry 或渲染器 switch 中。

## 7. Composer 斜杠别名（D123、ADR 0024、ADR 0106）

内置命令通过短别名显示在输入框 `/` 菜单中。别名定义在同时提供命令面板搜索的
同一 registry（`electron/main/builtin-commands.ts`）中；执行复用渲染器 switch。

| 别名 | 命令面板 ID |
|---|---|
| `/new` | `builtin.session.new` |
| `/compact` | `builtin.agent.compact` |
| `/agent-mode` | `builtin.mode.agent` |
| `/plan-mode` | `builtin.mode.plan` |
| `/goal-mode` | `builtin.mode.goal` |

别名与模板和插件命令名称共享一个命名空间；冲突时优先使用内置别名，其次是项目模板、
用户模板和插件命令。选择别名会插入 `/alias `；单独发送 `/new` 或 `/compact` 时，
会在本地执行，不会创建空提示。Agent/Plan/Goal 别名支持附带提示词：
`/agent-mode <prompt>`、`/plan-mode <prompt>` 或 `/goal-mode <prompt>` 会切换空闲会话
（或下一个会话默认值），并通过正常提示路径发送 `<prompt>`。不带正文的模式别名仍然
只执行本地切换。提示正文仍是可见的用户回合；dispatch 失败不会清除输入框草稿。
旧的内置别名不再解析，除非由其他命令来源提供，否则会作为普通未知斜杠文本处理。

## 8. 输入框中的 Skill 项

当前激活的内置、插件和用户 Skill 也会显示在输入框的 `/` 菜单中。它们使用精确的
Skill ID 作为斜杠名称，显示 Skill 名称和描述，并单独归入 **技能** 分组，排在扩展
命令之后。该分组始终位于最后；Skill 不会覆盖同名命令或模板。

选择 Skill 会插入 `/<skill-id> `。发送 `/<skill-id>`（可附带提示正文）时，输入的命令
会以可见的消息芯片保留，同时要求模型先用经过校验的 ID 调用现有的 `Skill` 工具，再
回答请求。只有当前项目已激活的 Skill 会被列出或接受，因此项目范围和插件激活状态
仍会在发送时强制校验。如果 Skill 已不再激活，文本会按普通未知斜杠提示处理。

## 9. 顿号打开斜杠菜单（D405）

中文输入法会用顿号「、」（U+3001）代替 ASCII 的 `/`，否则用户必须在书写中途切换
输入法才能唤出菜单。当输入框为空时，第 1 个字符提交的「、」会在触发检测之前被改写
为 `/`，随后按上文相同的插入、过滤与发送行为打开普通斜杠菜单。

只有空草稿的第 1 个字符会被改写。出现在草稿其他位置的「、」属于普通标点，始终不会
被改动；该别名对 `@` 文件菜单没有影响。
