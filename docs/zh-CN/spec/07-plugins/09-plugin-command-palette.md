# 09. 插件命令面板

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/09-plugin-command-palette) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


> **状态 — 合并到全局搜索中。** 独立命令面板覆盖已删除。插件（和内置）命令现在显示在全局搜索对话框的 **命令** 部分中，使用 `Cmd/Ctrl+Shift+P`（或 `Cmd/Ctrl+K`）打开。以下所有规则仍然适用于该部分。

## 1. 目标

提供快速命令入口点，将内置功能和插件功能的发现和执行统一在单个可搜索界面中。

## 2. 入口点

命令显示在全局搜索对话框中（“命令”部分）。相同的快捷方式可打开全局搜索并预先填充命令列表：

- macOS：`Command + Shift + P`（也为 `Command + K`）
- Windows/Linux：`Ctrl + Shift + P`（也为 `Ctrl + K`）

还可配置：
- 自定义快捷方式
- 启动器模式（稍后）

## 3. 命令模型

```ts
type CommandItem = {
 id: string
 title: string
 category?: string
 keywords?: string[]
 source: "builtin" | "plugin" | "extension"
 pluginId?: string
 extensionId?: string
}
```

## 4. 命令来源

1. 内置命令
 - 新建任务
 - 压缩对话上下文
 - 切换到 Agent / Plan / Goal
2. 已加载的 `pi.commands.register` 运行时命令，按项目激活范围过滤
3. 受信任 Agent 扩展命令（`source: "extension"`）

Composer `/` 目录独立，还包含技能和 MCP 条目，不是所有条目都进入全局命令搜索。

## 5. 搜索规则

当前 `commandPaletteSearch` 将查询转为小写，在标题、分类、合并关键词中做子串匹配，
中文作为文本参与匹配，空查询返回符合条件的列表。顺序为内置命令、已加载且符合项目范围的
插件命令、受信任扩展命令。不提供命令专属的最近使用排序、前缀评分、可配置权重或插件名字段搜索。

## 6. 执行流程

```text
open global search (Commands section)
 → input query
 → select command
 → execute
 → builtin handler
 → or plugin command bridge
 → close search / keep open (optional)
```

如果命令需要面板：
- 执行后打开PluginPanelHost

如果该命令需要权限：
- 先经过权限网关

## 7. UI 结构

```text
-------------------------------------------------
[ search input ]
-------------------------------------------------
Commands
 New Task
 Compact Conversation Context
Demo
 Hello: Open Panel
Tools
 ...
-------------------------------------------------
Enter to run · Esc to close
-------------------------------------------------
```

每一项显示：
- 标题
- 来源徽章 (builtin/plugin)
- 快捷方式提示（可选）

## 8. 空状态/错误

- 不匹配：显示“没有命令，尝试安装插件”
- 插件命令执行失败：toast + log
- 禁用插件：其命令不会出现

## 9. 与 Agent 的关系

命令界面（现在是全局搜索的一部分）并不能替代聊天编辑器。
它负责“发起行动”； chat 负责“会话任务”。

可能支持的命令：
- “将当前选择的命令结果发送到会话”（稍后）

## 10. 验收

1. 通过命令部分快捷方式打开全局搜索
2.内置和插件命令可搜索
3.执行插件命令成功
4. 插件禁用后命令消失
5. 子串匹配与内置/插件/扩展顺序符合 `market-ipc.ts`
