# PI-Desktop 插件开发：从零到一

> **翻译说明：** 本页是与 [英文源页面](/plugin-development) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


本指南是从空文件夹到经过测试的最短完整路径
`.piplug` 包。它描述了 PI-Desktop 今天发布的插件运行时。
[`docs/spec/07-plugins`](/zh-CN/spec/07-plugins/README) 下的文件仍然是
当本指南与规范不同时，规范性合同。

## 1. 插件可以添加什么

插件可以提供以下一项或多项功能：

| 能力 | 用它来 | 主要构建模块 |
|---|---|---|
| 命令 | 全局搜索中的显式操作 | `contributes.commands`、`pi.commands.register` |
| 面板 | 一个小的独立的 HTML 界面 | `ui.panel`、`ui.panel` 权限、`window.pluginBridge` |
| Agent 工具 | Agent 可以调用的函数 | `contributes.agentTools`、`pi.agent.registerTool` |
| 技能 | Agent 按需加载指令 | `contributes.skills`、`agent.prompt.inject` 权限 |
| 主题 | 设计令牌覆盖 | `contributes.themes`、`ui.theme` 权限 |
| MCP 服务器 | 从本地或远程 MCP 服务器发现的工具 | `contributes.mcpServers`，MCP 权限 |
| 服务 | 驻地工作由主人监督 | `contributes.services`、`background.service` 权限 |
| 消息总线 | 插件之间按约定类型化事件 | `contributes.bus`，总线权限 |

插件入口代码在专用的 Node 进程中运行。面板在沙盒中运行，
上下文隔离的 Electron 窗口，没有 Node 集成。来自任一方的呼叫
表面跨越主机拥有的权限网关。

> **信任边界：**权限模型对 `pi.*` 主机 API 和面板进行门控
> 桥梁。它还不是用于原始 Node API 的操作系统沙箱
> 插件输入过程。仅加载开发插件和第三方包
> 当您信任其来源并使用主机 API 而不是直接 Node 文件时
> 或网络访问。请参阅[安全规范](/zh-CN/spec/07-plugins/04-plugin-security)。

## 2.先决条件

对于推荐的应用优先路径，您需要：

- 正在运行的 PI-Desktop 版本；
- 插件的空文件夹；和
- 文本编辑器。

对于存储库 CLI 路径，您还需要 Node.js 22.19 或更高版本、pnpm 10 或
较新，并签出此存储库。 devkit 和 SDK 目前已
私有工作空间包，所以不要假设`npm install
@pi-desktop/plugin-devkit` 在此存储库之外工作。

## 3. 创建第一个插件

### 选项 A：在 PI-Desktop 中创建它

1. 打开 **插件**（扩展页面）。
2. 打开标题溢出菜单并选择 **从模板新建插件**。
3. 选择 `panel-basic`。
4. 选择一个空文件夹。

PI-Desktop 编写起始文件，加载文件夹作为开发插件，
并将该文件夹作为活动项目打开。该插件立即生效。

四个内置模板是：

| 模板 | 开始于 | 权限 |
|---|---|---|
| `panel-basic` | 命令和 HTML 面板 | `ui.panel` |
| `agent-tool-basic` | 代理可调用的 echo 工具 | `agent.tool.register` |
| `skill-pack` | 一份技能文件 | `agent.prompt.inject` |
| `full-demo` | 命令、面板、工具、技能和设置 | 这些功能使用的权限 |

脚手架拒绝非空目的地，因此它不能默默地覆盖
现有项目。

### 选项 B：使用存储库 CLI 创建它

从 PI-Desktop 存储库根目录：

```bash
pnpm install
pnpm --filter @pi-desktop/plugin-devkit... build
pnpm pi-plugin init panel-basic ../my-first-plugin \
  --id local.my-first-plugin \
  --name "My First Plugin"
```

然后打开PI-Desktop，进入**插件**，选择**加载开发插件**，然后
选择 `../my-first-plugin`。

例如，对已发布的插件使用反向域 ID
`com.example.workspace-summary`。 `local.` 前缀是一个有用的约定
私人插件。保持 ID 稳定：设置、数据、授权、更新和
包名称由它作为键。

## 4.了解生成的文件

`panel-basic` 模板生成：

```text
my-first-plugin/
├── manifest.json
├── main.js
├── README.md
└── renderer/
    └── index.html
```

- `manifest.json` 声明身份、入口点、贡献和请求
  权限。
- `main.js` 在插件进程中运行并导出生命周期挂钩。
- `renderer/index.html` 在隔离面板窗口中运行。
- `README.md` 解释了如何开发和打包这个特定的插件。

分发包必须包含直接可执行的 JavaScript、HTML、CSS、
和资产。 PI-Desktop 不会安装依赖项或编译 TypeScript
它加载一个插件。如果您使用 TypeScript 或第三方软件包、捆绑包或
在检查和打包之前将它们编译到插件目录中。

## 5. 手动构建最小插件

以下三个文件显示了完整的命令到面板路径。

### `manifest.json`

```json
{
  "schemaVersion": 1,
  "id": "local.my-first-plugin",
  "name": "My First Plugin",
  "version": "0.1.0",
  "description": "Opens a panel and shows a greeting.",
  "main": "main.js",
  "ui": {
    "panel": "renderer/index.html",
    "title": "My First Plugin",
    "width": 480,
    "height": 360
  },
  "contributes": {
    "commands": [
      {
        "id": "my-first-plugin.open",
        "title": "My First Plugin: Open Panel",
        "keywords": ["hello", "panel"]
      }
    ]
  },
  "permissions": ["ui.panel"],
  "engines": {
    "piDesktop": ">=0.1.0"
  },
  "activationEvents": [
    "onCommand:my-first-plugin.open",
    "onStartup"
  ]
}
```

需要 `schemaVersion`、`id`、`name`、`version` 和 `main`。每个文件
路径是相对于插件根目录的，并且必须保留在其中。仅声明
插件实际需要的权限。

### `main.js`

```js
async function onLoad() {
  await pi.commands.register({
    id: "my-first-plugin.open",
    title: "My First Plugin: Open Panel",
    keywords: ["hello", "panel"],
    run: async () => {
      await pi.ui.openPanel({ title: "My First Plugin" });
      await pi.ui.showToast("Hello from My First Plugin");
    },
  });
}

async function onUnload() {
  await pi.commands.unregister("my-first-plugin.open");
}

module.exports = { onLoad, onUnload };
```

主机将 `pi` 作为全局注入。 `onLoad` 和 `onUnload` 不接收任何参数。
CommonJS是最简单的入口格式；当条目是
ES 模块。模块评估加上 `onLoad` 有 15 秒预算。 `onUnload`
有 5 秒预算并且尽力而为，因此释放计时器和订阅
及时。

今天仅解雇 `onLoad` 和 `onUnload`。中的其他生命周期名称
清单是为计划的完整生命周期保留的。

### `renderer/index.html`

PI-Desktop 在 macOS、Windows 和 Linux 上都使用无边框窗口承载面板。
主机精确保留透明的 46 CSS 像素拖拽带，并只在右上角渲染最简胶囊，
其中包含最小化、最大化/还原和关闭三个按钮。面板标题、工具栏、背景
以及其他所有可见界面都由插件实现。普通流内容会由主机自动偏移到拖拽带
下方，不要再额外添加 46px 顶部内边距。拖拽带除胶囊外不可点击；开发面板
会显示这一限制的提醒。

如果面板使用 `position: fixed` 或 `position: sticky` 实现顶部界面，
不要使用 `top: 0`，而应使用主机变量：

```css
.panel-toolbar {
  position: sticky;
  top: var(--pi-plugin-titlebar-height, 46px);
  -webkit-app-region: drag;
}

.panel-toolbar button {
  -webkit-app-region: no-drag;
}
```

计算视口高度时也要扣除同一个 46px：
`height: calc(100dvh - var(--pi-plugin-titlebar-height, 46px))`。

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My First Plugin</title>
  </head>
  <body>
    <h1>My First Plugin</h1>
    <button id="hello">Show toast</button>
    <script>
      document.getElementById("hello").addEventListener("click", async () => {
        await window.pluginBridge.invoke("ui.showToast", {
          message: "Hello from the panel",
        });
      });
    </script>
  </body>
</html>
```

面板不接收全局 `pi` 对象。它只接收
`window.pluginBridge` 和任意 Electron IPC 通道不可用。

## 6. 添加功能

### 6.1 Agent 工具

声明该工具及其权限：

```json
{
  "contributes": {
    "agentTools": [
      {
        "name": "summarize_text",
        "description": "Summarize text supplied by the agent.",
        "risk": "low",
        "schema": {
          "type": "object",
          "properties": {
            "text": { "type": "string" }
          },
          "required": ["text"]
        }
      }
    ]
  },
  "permissions": ["agent.tool.register"]
}
```

在 `onLoad` 期间注册匹配的处理程序：

```js
await pi.agent.registerTool({
  name: "summarize_text",
  description: "Summarize text supplied by the agent.",
  risk: "low",
  schema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  execute: async (args, context) => {
    context.log("summarize_text called");
    const text = String(args?.text ?? "");
    return { summary: text.slice(0, 120) };
  },
});
```

在 `onUnload` 中取消注册。主机将其暴露给模型
插件命名空间名称，应用正常的 Agent 权限策略，审核
执行，并强制执行 110 秒的插件端超时。插件工具不是
在 Plan 模式下可用。

### 6.2 技能

添加一个文件，例如 `skills/release-notes.md`：

```markdown
---
name: Release notes
description: Use when the user asks for release notes or a changelog entry.
---

# Release notes

Write one line per user-visible change. Use imperative mood and put the newest
change first.
```

使用所需的权限声明它：

```json
{
  "contributes": {
    "skills": ["skills/release-notes.md"]
  },
  "permissions": ["agent.prompt.inject"]
}
```

提示收到简短的技能目录；全文可按需阅读。
每个插件最多可以贡献32个技能，每个文件最多128 KiB，
描述的上限为 240 个字符。没有技能
`agent.prompt.inject` 被忽略而不是加载。

### 6.3 设置和私有数据

在清单中声明默认值：

```json
{
  "contributes": {
    "settings": [
      {
        "key": "greeting",
        "title": "Greeting",
        "type": "string",
        "default": "Hello"
      }
    ]
  }
}
```

从插件进程中读取并更新它们：

```js
const settings = await pi.plugin.getSettings();
await pi.plugin.setSettings({ greeting: "Welcome" });
const dataPath = await pi.plugin.getDataPath();
```

设置和数据路径是插件 ID 私有的。插件页面会为 `string`、`number`、`boolean`、
`select`、`json` 和 `shortcut` 字段生成控件。快捷键字段必须关联一个已声明的命令：

```json
{
  "key": "openShortcut",
  "title": "Open panel shortcut",
  "type": "shortcut",
  "default": "Mod+Shift+H",
  "command": "hello.open",
  "scope": "plugin"
}
```

插件快捷键只在聚焦的 PI-Desktop 窗口中生效，并会避让应用快捷键；暂不支持全局注册。
用户编辑后插件会收到 `plugin:settingsChanged`。请勿将凭据放入 `manifest.json` 或源代码管理。

### 6.4 工作区文件、剪贴板、网络和通知

这些 API 需要明确的权限：

| 许可 | 插件进程 API | 面板桥通道 |
|---|---|---|
| `fs.read` | `pi.fs.readText`、`pi.fs.glob`、`pi.fs.requestDirectory` | `fs.readText`、`fs.glob` |
| `fs.write` | `pi.fs.writeText` | `fs.writeText` |
| `fs.delete` | `pi.fs.remove` | 没有暴露 |
| `clipboard.read` | `pi.clipboard.readText`、`pi.clipboard.getHistory` | `clipboard.readText`、`clipboard.getHistory` |
| `clipboard.write` | `pi.clipboard.writeText` | `clipboard.writeText` |
| `net.fetch` | `pi.net.fetch` | `net.fetch` |
| `shell.openExternal` | `pi.shell.openExternal` | `shell.openExternal` |
| `notify` | `pi.ui.notify`、`pi.ui.getNotificationPermission`、`pi.ui.requestNotificationPermission`、`pi.ui.showNativeNotification` | `ui.notify`、`ui.getNotificationPermission`、`ui.requestNotificationPermission`、`ui.showNativeNotification` |

文件权限只是声明的一半：`manifest.fs` 说明每种模式可以触碰哪些路径
（见 §6.5）。路径相对于该模式的 root。绝对路径、`..` 逃逸，以及离开 root
的软链都会被拒绝。`fs.remove` 不递归、把路径移进系统回收站，且无法删除
root 本身。`net.fetch` 接受 HTTP(S)，并且只能到达 `manifest.net.domains`
里列出的主机；`openExternal` 接受 HTTP(S) 和 `mailto:` URL。

`pi.ui.notify` 显示应用内 Toast。本机通知可选择加入：呼叫
`pi.ui.requestNotificationPermission()` 之前
`pi.ui.showNativeNotification(...)`。返回的权限是尽力而为的
因为 Electron 没有公开跨平台只读操作系统权限 API；
`unknown` 表示平台尚未上报结果，且
`unsupported` 表示桌面通知不可用。原生插件
通知不会添加到 PI-Desktop 的持久任务通知收件箱中。

面板桥还暴露 `ui.showToast`、`ui.closePanel`、
`plugin.getSettings` 和 `workspace.get`。主机自己没有实现的通道会被转发到
你的 `onPanelInvoke(channel, payload)`，因此面板可以通过你自定义的通道和自己
的插件通信；没有导出 `onPanelInvoke` 的插件会收到 `UNSUPPORTED`。

### 6.5 文件范围

`fs.read` / `fs.write` / `fs.delete` 说明你的插件能不能碰文件，
`manifest.fs` 说明能碰哪些：

```json
{
  "permissions": ["fs.read", "fs.write", "fs.delete"],
  "fs": {
    "read": { "scope": ["**/*"] },
    "write": { "scope": ["docs/**", "*.md"] },
    "delete": { "own": true, "scope": ["dist/**"] }
  }
}
```

- `scope` 里的 glob 相对 root。`*` 匹配一个路径段，`**` 跨分隔符匹配。
- **读取**可以声明整棵树，**写入和删除不行** —— 整棵树的模式无法通过校验：
  让宽松读取变得安全的是出网白名单，而没有任何东西能让宽松写入变得安全。
- 声明范围之外的访问不是错误：PI-Desktop 会问用户（拒绝 / 允许一次 /
  本会话允许）。请把需要的范围声明出来，别让插件每次调用都打断用户；
  同时要预期拒绝会以 `PERMISSION_DENIED` 的形式返回。
- 有些路径无论你声明什么都会被拒绝：`.env*`、SSH 与云凭证、`*.pem`、
  `.git/**`，以及 PI-Desktop 自己的数据目录。它们也不会出现在 `fs.glob`
  的结果里。

**删除。** `own: true` 允许你删除插件自己写过的文件，不需要 scope、不需要
弹窗 —— 清理自己产物的正确默认值。（如果用户在你写入之后改过这个文件，
它就不再算你的了。）删别的东西需要 `scope`。每次删除都不递归、进系统回收站，
并在一分钟内超过 50 次后被打断，所以批量清理应当按节奏进行，
而不是 `glob` 加一个循环。

**在工作区之外工作。** 在某个模式上设置 `"root": "userSelected"` 并调用
`pi.fs.requestDirectory()`：用户选一个目录，你在里面拥有完整可达范围，
不需要声明任何 scope。句柄存在内存里，插件进程退出即消失，所以每个会话都要
重新问一次。

**旧权限名。** `fs.read.workspace`、`fs.write.workspace`、
`fs.delete.workspace` 仍然能加载，但会被削减 —— 写入什么都到不了，删除只能
到自己的产物 —— 直到清单声明 `fs`。插件页面会把这件事告诉用户。

### 6.6 网络访问

`net.fetch` 让插件可以发请求，`manifest.net.domains` 说明能发到哪里：

```json
{
  "permissions": ["net.fetch"],
  "net": { "domains": ["api.example.com", "*.githubusercontent.com"] }
}
```

条目是裸主机名 —— 没有 scheme、没有端口、没有路径 —— 前缀 `*.` 同时覆盖
该域名及其子域名。裸 `*` 在安装时被拒绝。

这份列表是主机掌握的**每一条**出网路径的唯一白名单，不只是 `pi.net.fetch`：
面板自己的 `fetch`、`<img>`、`<script>` 和样式表加载同样听它的
（沙箱面板依然有网络栈），你声明的远程 HTTP MCP 服务器也一样。
面板里的 `window.open` 一律拒绝。

`net.domains` 缺失、为空或非法就意味着**完全不放行出网**，即使 `net.fetch`
已被授予。重定向由主机手工跟随并重新检查，所以被允许的主机没法把请求弹到
一个你没声明的主机上。请把资源打进插件包，而不是从一个你还得额外声明的 CDN
上加载。

### 6.7 主题

声明 CSS 文件和 `ui.theme`：

```json
{
  "contributes": {
    "themes": [
      {
        "id": "midnight",
        "label": "Midnight",
        "path": "themes/midnight.css",
        "base": "dark"
      }
    ]
  },
  "permissions": ["ui.theme"]
}
```

覆盖该 CSS 中的 PI-Desktop 设计标记。楼主对贡献的内容进行了清理
CSS，拒绝导入和非数据 URL，每个文件的上限为 256 KiB，并允许
每个插件有八个主题。用户在“设置”中选择主题。

### 6.8 MCP 服务器

MCP 服务器是声明性的。本地服务器需要 `mcp.server.local`；一个
远程服务器需要 `mcp.server.remote`：

```json
{
  "contributes": {
    "mcpServers": [
      {
        "id": "docs",
        "label": "Documentation tools",
        "transport": "stdio",
        "command": "bin/docs-server",
        "args": ["--stdio"],
        "env": {
          "DOCS_TOKEN": { "setting": "docsToken" }
        }
      },
      {
        "id": "issues",
        "transport": "http",
        "url": "https://mcp.example.com/tools",
        "headers": {
          "Authorization": { "setting": "issuesAuthorization" }
        }
      }
    ]
  },
  "permissions": ["mcp.server.local", "mcp.server.remote"]
}
```

stdio 命令必须是 `PATH` 上的裸命令或与插件相关的命令
可执行文件；绝对路径被拒绝。远程 URL 可以使用 HTTP 或 HTTPS，并且主机必须
列在 `net.domains` 中；非回环 HTTP 不加密，因此只应在可信网络中使用。设置
引用仅读取该插件的设置——主机环境和提供商秘密永远不会被转发。MCP 工具
遵循与手写插件工具相同的仅代理策略和命名空间。

### 6.9 常驻服务和消息总线

声明服务 ID 和允许的主题：

```json
{
  "contributes": {
    "services": [
      { "id": "watcher", "label": "Workspace watcher" }
    ],
    "bus": {
      "publish": ["example.index.ready"],
      "subscribe": ["example.build.*"]
    }
  },
  "permissions": [
    "background.service",
    "bus.publish",
    "bus.subscribe"
  ]
}
```

注册匹配的处理程序：

```js
let unsubscribe;

pi.services.register({
  id: "watcher",
  start: ({ log }) => log("watcher started"),
  stop: () => {},
});

unsubscribe = await pi.bus.subscribe("example.build.*", async (message) => {
  await pi.bus.publish("example.index.ready", {
    source: message.from,
    at: message.at,
  });
});
```

卸载期间调用 `unsubscribe()`。插件不接收自己的总线
消息。将主题视为对任何已安装的具有匹配插件的公共主题
订阅；切勿将秘密放入有效负载中。

## 7.权限设计

权限均在 `manifest.json` 中声明并由用户授予。
未声明或未授予的 API 调用失败并显示 `PERMISSION_DENIED`。

| 风险 | 权限 |
|---|---|
| 低 | `ui.panel`、`ui.theme`、`notify` |
| 中等 | `clipboard.read`、`clipboard.write`、`fs.read`、`shell.openExternal`、`background.service`、`bus.publish`、`bus.subscribe` |
| 高 | `fs.write`、`fs.delete`、`agent.tool.register`、`agent.prompt.inject`、`net.fetch`、`mcp.server.local`、`mcp.server.remote` |

有两个权限除了名字之外还带一个声明出来的范围，并且两者都会展示给用户：
文件模式看 `manifest.fs`（§6.5），出网看 `manifest.net.domains`（§6.6）。
两者都是失败即关闭 —— 缺失或为空的声明什么都不授予，所以对它们一言不发的
插件什么都到不了。

要求尽可能最小的一组。向已加载的开发插件添加权限
无法通过热重载生效：PI-Desktop 停止重载并
要求用户再次加载该文件夹，以便可以查看新的授权。
放宽 `manifest.fs` 在这件事上等同于添加权限。
删除权限在重新加载时生效。

完整的映射和策略位于
[权限矩阵](/zh-CN/spec/07-plugins/13-plugin-permissions-matrix)。

## 8. 开发和调试

### 热重载

在第一个文件夹加载后跨应用程序监视开发插件
重新启动。 300 毫秒去抖后重新加载更改。 `.git`、`node_modules`、
`dist`、`target` 和通用编辑器草稿文件将被忽略。

重新加载执行 `unload → validate → load`。不保留面板内存。一个
语法或明显错误卸载损坏的版本但保留观察者
活跃；保存修复以进行恢复。最多观看 16 个开发插件
一次。

### 验证每个贡献

- 从全局搜索运行命令（`Cmd/Ctrl+K` 或 `Cmd/Ctrl+Shift+P`）。
- 从命令或插件行打开面板。
- 要求 Agent 在 Agent 模式下调用贡献的工具。
- 请求与技能描述相匹配的任务，然后检查是否
  技能被选择。
- 在“设置”中选择贡献的主题。
- 检查插件行的服务状态和重新启动计数。

### 日志和失败

负载、崩溃、权限、工具、网络、服务和总线活动记录在
应用程序日志。打开 **设置 → 信息 → 日志**，然后搜索
插件 ID。面向用户的加载和热重载失败也显示为Toast和
当存在持续加载错误时，在插件行上。

主机 API 故障通常会引发 `Error` 和 `code`
`PERMISSION_DENIED`、`NOT_FOUND`、`INVALID_ARGUMENT`、`TIMEOUT`、`UNSUPPORTED`、
`LIMIT_EXCEEDED` 或 `RATE_LIMITED`。捕获可选操作的错误
并将代码包含在诊断中而不记录秘密。

## 9.检查、打包、安装

从存储库根运行验证：

```bash
pnpm pi-plugin check ../my-first-plugin
```

`check` 报告阻塞错误和非阻塞警告。它验证了
清单、引用的文件、权限、路径包含、符号链接、包
大小和文件计数使用与安装相同的规则。还要查看警告，
特别是未使用的和高风险的权限。

仅与开发套件一起打包：

```bash
pnpm pi-plugin pack ../my-first-plugin
```

结果是：

```text
../my-first-plugin/dist/local.my-first-plugin-0.1.0.piplug
```

该命令打印包 SHA-256。 `.piplug` 仅限商店
（未压缩）ZIP；正常的 `zip` 默认值通常会生成一个存档
安装人员拒绝。该开发套件不包括 `.git`、`node_modules` 和 `dist`，
拒绝符号链接，并强制最多 2,000 个文件和 50 MiB。

要测试用户收到的确切工件：

1. 打开**插件**。
2. 从标题溢出菜单中选择“**安装插件包**”。
3. 选择生成的`.piplug`。
4.检查权限并安装。
5. 重复上一节中的贡献检查。
6. 禁用并重新启用它以验证清理和启动行为。
7.卸载并确认其贡献消失。

Agent 还可以在每种操作模式下运行 `PluginCheck`。 `PluginScaffold`
和 `PluginPack` 是代理模式工具，仅限于当前
工作区。

## 10. 准备发布

共享包之前：

1. 使用稳定的反向域插件id。
2. 使用语义版本控制更新 `version`。
3. 将 `engines.piDesktop` 设置为您实际支持的版本。
4. 记录每个命令、设置、工具输入、权限和外部
   插件 README 中的服务。
5. 添加变更日志和许可证。
6. 将所有生成的 JavaScript 和资源构建到插件文件夹中。
7. 运行 `pi-plugin check` 并解决每个错误和意外警告。
8. 运行 `pi-plugin pack` 并以干净的应用程序状态安装生成的包。
9. 在发布工件旁边记录打印的 SHA-256。

对于官方市场，请将包和目录元数据提交至
[`vastsa/pi-desktop-plugins`](https://github.com/vastsa/pi-desktop-plugins) 和
遵循该存储库的 `CONTRIBUTING.md`。市场目录是
单独的存储库；在这里添加插件不会发布它。

签名不是当前的信任原语。包 SHA-256 和显式
许可审查是实施的基线；遵循
[签署和更新规范](/zh-CN/spec/07-plugins/08-plugin-signing-updates)
了解路线图详细信息。

## 11. 故障排除

| 症状 | 可能的原因 | 修复 |
|---|---|---|
| `manifest.json is missing` | 选择了错误的目录 | 选择根目录包含 `manifest.json` 的目录 |
| `main entry missing` | `main` 指向未构建的源 | 首先Compile/bundle或者更正相对路径 |
| 面板打不开 | 缺少文件、`ui.panel` 或权限 | 声明面板路径和`ui.panel`；重新加载以获得新的补助金 |
| `pluginBridge` 不可用 | 在普通浏览器中打开的 HTML | 在 PI-Desktop 面板内测试桥接调用 |
| 工具从未出现 | 缺少贡献、注册或资助 | 对齐 `agentTools`、`registerTool` 和 `agent.tool.register`；使用 Agent 模式 |
| 技能永远不适用 | 缺少权限或元数据薄弱 | 添加 `agent.prompt.inject` 和特定 `name`/`description` 前面的内容 |
| 保存报告 `PERMISSION_DENIED` | 清单扩大了权限 | 再次加载开发文件夹并查看新的授权 |
| 语法错误后热重载停止 | 损坏的插件已卸载 | 保存修正后的文件；观察者保持活跃状态 |
| 包安装拒绝压缩 | 存档是使用通用 ZIP 工具制作的 | 使用 `pi-plugin pack` 重建它 |
| MCP 服务器未启动 | 传输字段、命令、URL、设置或权限无效 | 运行 `pi-plugin check`，然后通过插件 ID 检查日志 |
| 服务反复重启 | `start` 抛出异常或插件进程退出 | 使 `start` 幂等，在 `stop` 中进行清理，并检查重新启动日志 |

## 12.参考图

- [示例插件](https://github.com/vastsa/PI-Desktop/tree/main/examples/plugins)
- [插件系统概述](/zh-CN/spec/07-plugins/01-plugin-system)
- [Manifest Schema](/zh-CN/spec/07-plugins/02-plugin-manifest-schema)
- [主机 API](/zh-CN/spec/07-plugins/03-plugin-api)
- [生命周期](/zh-CN/spec/07-plugins/05-plugin-lifecycle)
- [包装](/zh-CN/spec/07-plugins/06-plugin-packaging)
- [开发者体验](/zh-CN/spec/07-plugins/10-plugin-devex)
- [权限](/zh-CN/spec/07-plugins/13-plugin-permissions-matrix)
- [Hello 参考插件](https://github.com/vastsa/PI-Desktop/tree/main/examples/plugins/hello)
