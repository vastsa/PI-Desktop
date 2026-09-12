# 10. 插件开发者体验

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/10-plugin-devex) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 目标

让开发人员在 10 分钟内创建并加载本地插件。

面向任务的【从零到一的插件开发指南】(../../plugin-development.md)
涵盖了完整的作者旅程。该规范冻结了开发人员
表面及其验收标准。

## 2. 开发者路径

```text
Create from template            (the folder opens as the project)
 → edit manifest / main / panel   (hot reload keeps it live)
 → verify in the command palette
 → check
 → pack piplug
```

第一步有三个入口点，都调用相同的
`@pi-desktop/plugin-devkit` 实施：

- **插件页面** — 溢出菜单的“来自模板的新插件”，或
  按钮处于空状态。选择一个模板，请求一个文件夹，写入
  文件，将结果加载为开发插件，然后打开该文件夹
  活动项目，因此源已经在代理的工作区中并且
  文件面板读取。如果该文件夹无法作为项目打开，则该插件
  仍然保持加载状态，并且 toast 仅表示它已创建并加载。
- **Agent** — `PluginScaffold`，在对话中（“给我写一个插件……”）。
  它在已打开的当前工作区中写入。
- **CLI** — `pnpm pi-plugin init <template> <dir>`。

## 3. 模板类型

官方模板，全部四个可用：

1.`panel-basic`：面板+命令
2. `agent-tool-basic`：注册工具
3. `skill-pack`：仅限技能
4.`full-demo`：面板+命令+工具+技能+设置

每个模板都用 `schemaVersion: 1`、`main.js` 和 `main.js` 构建清单。
自述文件，并且仅包含模板实际使用的权限。脚手架拒绝
写入非空目录。

当前回购示例：
- `examples/plugins/hello`

## 4. SDK 和 devkit

`@pi-desktop/plugin-sdk` 由插件代码本身导入并保留
无依赖且无节点。它提供：
- 清单类型
- 权限枚举
- API 类型 (`PiPluginHostApi`)
- 清单验证功能
- 测试助手（模拟主机）

SDK 的剪贴板接口包含 `pi.clipboard.getHistory()`，通过现有的 `clipboard.read` 权限
返回有界、按最新优先排列的文本和图片条目。主机只记录明确的写入和 Composer 粘贴事件，
不会在后台轮询。插件应使用此 API 实现剪贴板历史功能，而不是轮询 `readText()` 并维护
第二份存储。

`@pi-desktop/plugin-devkit` 是工具，而不是运行时，并且可以使用 Node。它拥有
`scaffold` / `check` / `pack` 和 `pi-plugin` CLI。三位开发商
表面（CLI、代理工具、插件页面）调用它，因此一旦成立就会强制执行规则
无处不在。

## 5. 本地开发命令

CLI 目前作为私有工作区包提供。从结账处
在此存储库中，安装依赖项并构建 devkit 及其
依赖一次：

```bash
# repository setup
pnpm install
pnpm --filter @pi-desktop/plugin-devkit... build

# create from a template
pnpm pi-plugin init full-demo /tmp/my-plugin

# validate manifest and package contents
pnpm pi-plugin check .

# pack
pnpm pi-plugin pack .

# outputs dist/demo.hello-0.1.0.piplug

# pack and pin the version to the commit that produced it
pnpm pi-plugin publish .

# also writes dist/demo.hello-0.1.0.submission.json
```

`publish` 用于通过插件中心分发。它先打包，再把规范化仓库 URL、tag 或 commit ref、
解析后的 commit 以及插件子目录，连同安装包校验和一起记录下来，使制品与它声称的来源
描述同一个时刻。它拒绝有未提交改动的工作区，也拒绝带凭证的 git remote；当 HEAD 上
没有 tag 时给出警告。插件中心会自行重新解析这些值；一次提交只是一个待核验的声明。
见 [15-plugin-center.md](15-plugin-center.md)。

`check` 重现安装程序强制执行的每条规则，因此 `check` 传递意味着
安装会通过。它报告错误 - 丢失或无法解析的 `manifest.json`，
缺少 `main` / `ui.panel` / 技能文件，转义插件的技能路径
目录，未知权限，符号链接，超过 2000 个文件，超过
50 MB — 以及警告，不会阻止：高风险权限、权限
声明但从未被代码使用，`contributes.skills` 不带
`agent.prompt.inject`（技能将是惰性的），以及空的 `contributes`。

`pack` 写入 `dist/<id>-<version>.piplug`，跳过 `.git` 和 `node_modules`
与安装程序的副本完全相同，并打印 sha256。它运行 `check`
首先并拒绝打包有错误的插件。 **条目已存储
未压缩（方法 0）**：安装程序不接受任何其他内容，因此 `.piplug`
绝不能使用 `zip` 或其他 shell 工具构建。

## 6. Agent 工具

Electron main 提供三个工具（host-core 从未见过它们），每个工具
针对会话的工作空间根解析其 `directory` 参数并
拒绝逃避它：

| 工具 | 模式 | 效果 |
|---|---|---|
| `PluginCheck` | 全部 | 验证插件目录；只读 |
| `PluginScaffold` | 代理人 | 编写模板，然后将其作为开发插件加载 |
| `PluginPack` | 代理人 | 验证，然后写入 `dist/<id>-<version>.piplug` |

内置技能 `apps/desktop/resources/skills/plugin-development.md`，
记录清单模式、权限层、主机 API 表面，以及
这个循环。仅当会话工作区看起来像插件时才会激活
开发 — 工作区根目录下的插件 `manifest.json`，或者加载的
里面有开发插件——所以普通会话只需支付这三个工具的费用
描述。脚手架编写一个清单，从
下一个提示；从插件页面上的模板创建也会打开新的
文件夹作为项目，因此工作区测试立即通过。

## 7. 热重载

从那时起，从文件夹加载的插件就会被监视，包括跨
重新启动：文件夹被选取一次，而不是每次编辑一次。

- 插件目录下的任何更改都会重新加载它，去抖 300 毫秒，所以一个
  保存突发是一次重新加载。 `node_modules`、`.git`、`dist`、`target` 和编辑器
  临时文件被忽略 - 写入自己的 `dist/` 的插件不得
  永远重新加载自己。
- 重新加载会卸载之前的进程并再次从磁盘运行插件，因此
  清单、`main` 或技能更改都以相同的方式生效。面板是
  从重新加载的贡献中重新创建。
- **重新加载永远不会扩大权限。**重新加载首先读取清单
  并将其与选取文件夹时批准的集合进行比较；任何东西
  new 使用 `PERMISSION_DENIED` 停止重新加载并显示加载插件的消息
  再次审查补助金。删除的权限确实生效
  立即——拨款按照清单向下，而不是向上。
- 插件页面在开发插件行的“更多操作”菜单中提供“重载插件”。经过一次
  权限门控热重载，明确选择它会重新加载已注册的
  包含当前清单的文件夹并刷新所使用的权限上限
  稍后文件监视重新加载。该操作不需要再次选择文件夹。
- 重新加载失败（语法错误，无效清单）导致插件卸载
  但仍然观看，因此修复它的保存会恢复插件。失败
  被报告为一个 toast 加上一个插件更改事件；注册表行没有
  当前移至 `load_error`，因为 host-core 没有 RPC
  运行时端加载失败。
- 观察者在卸载、禁用、卸载和退出时被释放，并且有上限
  共有 16 个插件；超过上限后，应用程序日志和编辑需要手动重新加载。

## 8. 调试

今天实施：

- 加载和热重载失败显示为 toast；也持续出现负载故障
  出现在插件行。
- 打开 **设置 → 信息 → 日志** 并通过 `pluginId` 过滤记录进行检查
  生命周期、主机 API、工具、服务和总线活动。
- 插件页面显示声明的功能、权限和驻留
  服务状态。注册的命令可以在全局搜索中验证。

后来：

- 专用的每个插件日志面板，具有堆栈复制功能
- 面板专用开发工具
- 模拟工具调用程序

## 9. 文档清单（开发人员网站/存储库文档）

- 快速启动
- 清单字段
- 权限参考
- API 手册
- 出版手册（pack/sign）
- 安全最佳实践

## 10. 质量门（发布前推荐）

- `pi-plugin check` 报告没有错误
- 不会调用未声明的权限
- 有一个自述文件
- 有版本变更日志
- 如果包含工具：提供参数示例

## 11. 验收

1. 可以从模板、插件页面、代理创建新插件
   或 CLI
2.开发加载成功
3. 编辑重新加载插件而不重新选择其文件夹，以及损坏的编辑
   下次保存时恢复
4. `check` 通过并安装 `pack` 工件
5. 当授予 `agent.prompt.inject` 时，声明的技能达到模型，并且
   当权限被撤销时将停止到达它
