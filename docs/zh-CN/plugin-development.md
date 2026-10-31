# PI-Desktop 插件开发：从零到一

> **翻译说明：** 本页是与 [英文源页面](/plugin-development) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


本指南是从空文件夹到经过测试的最短完整路径
`.piplug` 包。它描述了 PI-Desktop 今天发布的插件运行时。
[`docs/spec/07-plugins`](/zh-CN/spec/07-plugins/README) 下的文件仍然是
当本指南与规范不同时，规范性合同。

## 1. 插件可以添加什么

插件可以提供以下一项或多项功能：

| 能力 | 用途 | 主要 API 与声明 |
|---|---|---|
| 命令 | An explicit action in global search | `contributes.commands`, `pi.commands.register` |
| 独立面板 | A small isolated HTML interface | `ui.panel`, `ui.panel` permission, `window.pluginBridge` |
| 悬浮挂件 | A transparent, frameless companion window — a round orb, not a rectangle | `ui.panel` permission, `"ui": { "shape": "widget" }`, `window.pluginBridge` |
| 工作面板视图 | An interface docked in the app's right work panel | `contributes.views`, `ui.view` permission, `window.pluginBridge` |
| Agent 工具 | A function the Agent can call | `contributes.agentTools`, `pi.agent.registerTool` |
| OAuth Provider | A provider row with host-owned sign-in and encrypted credentials | `contributes.providers`, `provider.oauth`, `onProviderOAuth` |
| 单次补全 | A host-owned completion against the user's models | `pi.models.list`, `pi.session.getLlmContext`, `pi.agent.complete` |
| 技能 | Instructions loaded by the Agent on demand | `contributes.skills`, `agent.prompt.inject` permission |
| 主题 | Design-token overrides | `contributes.themes`, `ui.theme` permission |
| MCP 服务器 | Tools discovered from a local or remote MCP server | `contributes.mcpServers`, an MCP permission |
| 常驻服务 | Resident work supervised by the host | `contributes.services`, `background.service` permission |
| 消息总线 | Typed-by-convention events between plugins | `contributes.bus`, bus permissions |
| 渲染器插槽 | UI drawn inside the app's own window: composer controls, message action bars, blocks below a reply, tool cards, code-block renderers, corner layers | `renderer`, `renderer.extension` permission, `packages/plugin-sdk/src/renderer.ts` |
| 输入框建议 | One dismissible line offered to the input box, taken with Tab | `pi.composer.suggest`, `composer.suggest` permission |
| 模型 Provider | API-key, no-auth, or OAuth model service | `contributes.providers`, `provider.register`; OAuth also needs `provider.oauth` |
| 会话导入 | Import, read, rename, and delete this plugin's own history | `contributes.sessionSources`, matching `session.*` grants |
| 用量事实 | Compute your own usage dashboard | `pi.usage.listTurns`, `usage.read` |
| 输入框转换 | An explicit draft-text action with undo | `contributes.composerTransforms`, `onComposerTransform`, `composer.transform` |
| 系统快捷键 | Invoke your command while the app is unfocused | `contributes.globalShortcuts`, `pi.keyboard`, `keyboard.globalShortcut` |
| 受信任 Agent 扩展 | pi ExtensionAPI hooks, tools, commands, and custom agents | `contributes.agentExtensions`, `agent.extension` |
| 实时连接 | Host-owned, bounded WebSockets | `pi.net.websocket`, `net.websocket` |
| 浏览器与桌面控制 | Reviewed browser or app operations | `pi.browser`, `browser.cdp`; `pi.desktop`, `desktop.control` |
| 语音适配器 | Add a speech protocol handled by the plugin process | `pi.speech`, `speech.adapter.register` |

插件入口代码在专用的 Node 进程中运行。面板在沙盒中运行，
上下文隔离的 Electron 窗口，没有 Node 集成。来自任一方的呼叫
表面跨越主机拥有的权限网关。

> **信任边界：**权限模型对 `pi.*` 主机 API 和面板进行门控
> 桥梁。它还不是用于原始 Node API 的操作系统沙箱
> 插件输入过程。仅加载开发插件和第三方包
> 当您信任其来源并使用主机 API 而不是直接 Node 文件时
> 或网络访问。请参阅[安全规范](/zh-CN/spec/07-plugins/04-plugin-security)。

## 2. 先决条件

对于推荐的应用优先路径，您需要：

- 正在运行的 PI-Desktop 版本；
- 插件的空文件夹；和
- 文本编辑器。
- 若要导入带 npm 依赖的 pi 扩展目录，`PATH` 中必须有系统 `npm` 可执行文件。发布版不附带独立 Node/npm；缺少 npm 时，PI-Desktop 会报告警告，导入扩展的依赖无法加载。

仓库 CLI 路径使用根目录 `package.json` 中 `engines` 和 `packageManager`
声明的 Node.js、pnpm 版本，并需要本仓库的检出副本。 devkit 和 SDK 目前已
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

## 4. 了解生成的文件

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

宿主注入全局 `pi`；主进程的 `onLoad` 和 `onUnload` 不接收参数。支持 CommonJS 和 ESM。
模块求值与 `onLoad` 共用 15 秒预算；`onUnload` 为 5 秒，应用退出时缩短至 1.5 秒。
只有这两个生命周期钩子会执行。`onPanelInvoke`、`onRendererCall`、`onComposerTransform`、
`onProviderOAuth` 是操作回调；`onInstall`、`onEnable`、`onDisable`、`onUninstall` 不会执行，
也没有 `entrypoints` 清单分发器。

OAuth 回调只处理自己声明的 Provider，凭证由宿主加密保存。`provider.oauth` 是高风险权限；
通过宿主 API 请求令牌仍需 `net.fetch` 和相应出网范围，详见 §6.13。

### `renderer/index.html`

PI-Desktop 在 macOS、Windows 和 Linux 上都使用无边框窗口承载面板。
主机精确保留透明的 46 CSS 像素拖拽带，并只在右上角渲染最简胶囊，
其中包含最小化、最大化/还原和关闭三个按钮。面板标题、工具栏、背景
以及其他可见界面都由插件实现。新页面应声明 `<meta name="pi-plugin-chrome" content="v2">`，
并用 `var(--pi-plugin-titlebar-height, 0px)` 自行添加一次顶部间距。没有此标记的旧页面
由宿主自动偏移，不要再加第二份 46px 间距。拖拽带除胶囊外不可点击，开发面板会提示。

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

### 悬浮挂件

如果一个插件的全部界面就是一个小小的悬浮形状——语音球、计时器、状态灯——
就在清单里声明 `"ui": { "shape": "widget" }`，而不是接受一个带工具栏条的矩形。
面板此时会以透明、无边框的窗口打开：

- 没有 46px 拖拽带，也没有胶囊；`--pi-plugin-titlebar-height` 为 `0px`
- 空白处拖动窗口；标准控件或任何带 `data-pi-plugin-no-drag` 标记的元素保持可点击
- 在挂件上右键打开宿主菜单：关闭、最小化、始终置顶
- `ui.width` / `ui.height` 最小可到 120×120，`ui.alwaysOnTop` 让挂件浮在其他窗口之上
- 页面可读取 `document.documentElement.dataset.piPluginPanelShape`
  （`panel` | `widget` | `view`），让同一份 HTML 适配三种位置

自己绘制轮廓——`border-radius: 50%`、自定义阴影、溢出到形状之外的辉光——并让
页面背景在轮廓之外保持透明，窗口就会隐没在形状之后。其余部分（`window.pluginBridge`、
权限、设置）与面板完全一致。

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="pi-plugin-chrome" content="v2" />
    <title>My First Plugin</title>
    <style>body { padding-top: var(--pi-plugin-titlebar-height, 0px); }</style>
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

在 `onUnload` 中注销工具。宿主使用命名空间名称、正常权限策略和审计，插件侧超时为 110 秒。
工具通过 `ToolSearch` 按需加载，默认在 Plan/Goal 中隐藏并拒绝。
只有运行时注册描述符明确提供 `planSafeActions`，且 `args.action` 在该列表中时，才允许在这些
模式执行。声明应只列只读操作，并与清单保持一致；有 schema action enum 时会校验取值。
`risk: "low"`、会话授权和 `auto` 都不能代替该声明。
通过 `context.signal` 处理取消，用 `context.sessionId` / `turnId` 关联发起调用的会话和轮次，
不能替换成当前可见会话。

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

插件快捷键只在聚焦的 PI-Desktop 窗口中生效，并会避让应用快捷键；系统级快捷键使用独立的 `contributes.globalShortcuts`、`pi.keyboard` 和
`keyboard.globalShortcut` 权限（§6.17）。
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
通知不会添加到 PI-Desktop 的持久任务通知收件箱中。点击已交付的通知会恢复并聚焦主窗口，
但不会激活会话。

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

没有 `net.anyHost` 时，缺失或空的 `net.domains` 不提供出网权限，即使已授予 `net.fetch`；
非法声明会校验失败。重定向由宿主手工跟随并逐跳检查，不能跳到授权范围之外。请把资源打进插件包，而不是从一个你还得额外声明的 CDN
上加载。

`fetch` 返回服务器实际给出的内容，`429` 和 `Retry-After` 都在内：宿主从不重试
你的插件发出的请求，所以遇到限流之后的退避是你自己的策略，而不是主机隐藏的
行为。返回 `>= 400` 的调用依然会进审计，记为 `ok: false` 并带上它通告的延迟。

`net.anyHost` 是安装时单独确认的高风险权限，用于用户输入的自建端点。
它放宽域名列表，覆盖 fetch、WebSocket、面板和远端 MCP，但仍拒绝云元数据地址，
也不会单独授予 fetch 或 socket API。

### Fetch redirect policy

依赖重定向策略前，必须先查询能力。旧宿主可能忽略未知字段，不能回退到原始网络请求。

```js
if (typeof pi.net.getCapabilities !== "function") throw new Error("Upgrade PI-Desktop");
const capabilities = await pi.net.getCapabilities();
if (!capabilities.fetchRedirectModes.includes("error")) throw new Error("Unsupported host");
const response = await pi.net.fetch({ url: endpoint, redirect: "error" });
```

`error` 在访问 Location 前拒绝所有 3xx，错误为 `REDIRECT_DISALLOWED`。
`manual` 返回首个响应；省略或 `follow` 最多跟随 5 次，每跳重新校验出网策略。
非法值在 I/O 前拒绝，所有模式都不会扩权。

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
        "base": "dark",
        "assets": ["themes/background.svg"]
      }
    ],
    "windowAppearance": {
      "backgroundColor": { "dark": "#141a24", "light": "#f5f7fa" }
    }
  },
  "permissions": ["ui.theme", "ui.window.appearance"]
}
```

`base` 选择底层的 `light` 或 `dark` 调色板，省略时为 `dark`。用户在设置中选择主题。
覆盖设计令牌时，应匹配宿主调色板选择器：

```css
:root[data-theme="dark"] { --ds-bg-primary: #141a24; }
:root[data-theme="light"] { --ds-bg-primary: #f5f7fa; }
```

样式表在宿主样式之后追加，但后写的声明只有在特异度相同时才胜出。单独的 `:root`
特异度低于 `:root[data-theme="dark"]` 和 `:root[data-theme="light"]`，因此不能保证覆盖。

CSS 会经过清理：拒绝 `@import`，`url()` 仅允许 `data:` 或已声明的资源。
每份 CSS 上限 256 KiB；不限制每个插件的主题数量。每份主题资源总量上限 4 MiB，
支持 `png`、`jpg`、`jpeg`、`webp`、`avif`、`svg`、`woff2`。资源路径可以是插件内相对路径
或经过单独验证的绝对路径；匹配的 URL 会被重写为只读的 `plugin-asset://` 地址，
卸载后失效，渲染器不会收到原始文件系统路径。

`windowAppearance.backgroundColor` 支持 `#rrggbb` 或 `#rrggbbaa`，需要
`ui.window.appearance`，仅在本插件主题选中时生效。macOS 默认透明窗口会忽略该颜色，
关闭 **Translucent window** 后才应用到不透明窗口。`cornerRadius` 接受 0..24 DIP 整数；
Windows 11 的 0 表示直角，正数使用系统圆角，macOS 保持原生圆角。
完整字段见[清单规范](/zh-CN/spec/07-plugins/02-plugin-manifest-schema)。


运行时改主题无需重载：`pi.themes.upsert`、`remove`、`list`、`pi.app.setTheme` 使用 `ui.theme`。
`pi.themes.setVariables(themeId, values)` 只接受本主题已声明的类型变量
（`length`、`number`、`color`、`select`），不接受任意 CSS 或宿主保留变量。
`contributes.scenicThemes` 通过宿主渲染 1..12 张设置卡片，需要 `ui.settings` 与 `ui.theme`。
任意 HTML/JS 形式的 `settingsDestinations` 不是公开贡献点。

### 6.8 工作面板视图

`contributes.views` 声明停靠在工作面板中的隔离 HTML 页面，需要 `ui.view`。
可以和独立面板共用 HTML；停靠时没有窗口控制条，`--pi-plugin-titlebar-height` 为 `0px`。

```json
{
  "contributes": {
    "views": [
      {
        "id": "changes",
        "title": { "en": "Changes", "zh-CN": "改动" },
        "icon": "diff",
        "entry": "views/changes.html",
        "order": 10
      }
    ]
  },
  "permissions": ["ui.view"]
}
```

标题支持字符串或 `{ en, "zh-CN" }`。图标使用 SDK 的 `PLUGIN_VIEW_ICONS` 列表，
未知名称显示字母方块，检查器会给出警告。激活范围不匹配的项目不会显示该视图。
用 `pi.ui.revealView({ viewId, sessionId, location })` 显示自己的视图；指定已不在前台的
会话会被拒绝。首次位置通过 URL 参数 `piViewOpen` 传入，加载后的新位置通过
`view:open` 事件 `{ path }` 传入，不重载页面，也不丢弃未保存状态。

`examples/plugins/hello/views/greetings.html` 是最小示例，
`apps/desktop/resources/plugins/pi.file-manager` 是完整实现。
自定义 `onPanelInvoke` 操作必须自行验证输入；宿主不会自动把它们变成受 `pi.fs` 权限控制的调用。

### 6.9 MCP 服务器

MCP 服务器是声明性的。本地服务器需要 `mcp.server.local`；一个
远程服务器需要 `mcp.server.remote`：

```json
{
  "contributes": {
    "settings": [
      { "key": "docsMode", "title": "Docs mode", "type": "string", "default": "public" },
      { "key": "clientName", "title": "Client name", "type": "string", "default": "my-plugin" }
    ],
    "mcpServers": [
      {
        "id": "docs",
        "label": "Documentation tools",
        "transport": "stdio",
        "command": "bin/docs-server",
        "args": ["--stdio"],
        "env": {
          "DOCS_MODE": { "setting": "docsMode" }
        }
      },
      {
        "id": "issues",
        "transport": "http",
        "url": "https://mcp.example.com/tools",
        "headers": {
          "X-Client-Name": { "setting": "clientName" }
        }
      }
    ]
  },
  "permissions": ["mcp.server.local", "mcp.server.remote"],
  "net": { "domains": ["mcp.example.com"] }
}
```

stdio 命令必须是 `PATH` 上的裸命令或插件相对路径的可执行文件；绝对路径会被拒绝。
`npx` 和 `uvx` 会解析到真实的 Node.js / uv（PATH、官方 Node 安装、fnm、nvm、Volta、
默认 uv 安装位置）。远程 URL 可以使用 HTTP 或 HTTPS，并且主机必须列在
`net.domains` 中；非回环 HTTP 不加密，因此只应在可信网络中使用。设置引用仅读取
该插件的设置——主机环境和提供商密钥永远不会被转发。MCP 工具遵循与手写插件工具
相同的按需工具目录与命名空间。MCP 工具默认中风险，不会因服务器声称只读就自动获得 Plan 权限。

### 6.10 常驻服务和消息总线

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

### 6.11 Agent 扩展（pi ExtensionAPI 模块）

插件可以携带直接在 agent 进程内运行的代码：一个面向 pi CLI `ExtensionAPI` 编写的
模块，与 pi 扩展使用同一契约。它可以注册工具、斜杠命令，以及每个回合、每次工具调用
和每次 provider 请求上的 hook。声明模块和 `agent.extension` 权限：

```json
{
  "contributes": { "agentExtensions": ["src/index.ts"] },
  "permissions": ["agent.extension"]
}
```

```ts
// src/index.ts
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

export default function (pi) {
  pi.registerTool(defineTool({
    name: "fx_add", label: "Add", description: "两数相加",
    parameters: Type.Object({ a: Type.Number(), b: Type.Number() }),
    async execute(_id, { a, b }) {
      return { content: [{ type: "text", text: String(a + b) }], details: {} };
    },
  }));
  pi.on("tool_call", (event) =>
    event.toolName === "Bash" ? { block: true, reason: "这里不允许" } : undefined,
  );
  pi.registerCommand("greet", {
    description: "打个招呼",
    async handler(args, ctx) {
      const name = await ctx.ui.input("你的名字？");
      ctx.ui.notify(`你好 ${name} ${args}`);
    },
  });
}
```

使用前需要知道：

- **没有沙箱。** 模块在 agent 进程内运行，拥有与 agent 自身工具相同的权限。
  `agent.extension` 是需要用户显式确认的高风险权限；列出模块却没有它的 manifest
  会被拒绝。
- **可以直接写 TypeScript。** 模块由 jiti 加载，`.ts` 不需要构建步骤。`typebox`、
  `@earendil-works/pi-agent-core`、`@earendil-works/pi-ai` 和
  `@earendil-works/pi-coding-agent` 解析到应用自带的副本；`@earendil-works/pi-tui`
  解析到空实现桩，终端 UI 调用不做任何事，只在诊断里出现。
- **工具是延迟激活的。** 与插件工具一样，模型按需通过 `ToolSearch` 激活。与核心工具
  或插件工具同名的注册会被拒绝并记诊断。
- **斜杠命令**出现在 composer 的 `/` 菜单和全局搜索里，行的其余部分作为 `args`。
  `ctx.ui.input` / `select` / `confirm` 打开原生对话框；`ui.notify` 是 toast。
- **受支持的成员**见规格 07-plugins/16 §5。不支持的成员（`setWidget`、
  `registerMessageRenderer`、`navigateTree` 及其他仅终端可用的界面）是空操作，在插件行
- **已有的 pi 扩展**无需修改：插件页 → 溢出菜单 →“导入 pi 扩展”会把文件或目录包成
  生成的插件。若目录声明了生产或可选依赖，PI-Desktop 会先运行
  `npm install --package-lock-only --omit=dev --legacy-peer-deps --no-audit --no-fund
  --ignore-scripts`，校验生成的 registry-only lockfile，再以相同安全参数运行 `npm ci`。
  生产、可选、开发和 peer 字段中的直接依赖 spec 都会校验，git 解析会被禁用，绝不运行
  第三方生命周期脚本。需要构建脚本的原生模块会以诊断形式加载失败——在插件目录内用
  Electron 头重建（`npx @electron/rebuild -v <electron 版本>`）即可修复。安装失败会清理
  部分依赖并显示警告 toast，不会阻塞导入；只有扩展实际加载失败时插件行才显示 load error。

### 6.12 渲染器插槽

上面每一种界面都是插件自己拥有的窗口或页面。**渲染模块**则绘制在 PI-Desktop 自己的窗口里：
输入区工具栏上的控件、消息操作栏上的条目、助手回复下方的区块、自有 Agent 工具的卡片、
代码块的渲染器，或者你自己管理的角落浮层。

```json
{
  "permissions": ["renderer.extension"],
  "renderer": "renderer/index.mjs",
  "rendererActions": ["plugin.call", "composer.insertText"],
  "rendererCallMethods": ["openWorkspace"]
}
```

入口导出 `onLoad(pi)`，宿主在自己的窗口中求值它，并且每次加载都会给一份新的 `pi`。
组件的 props 只携带数据，因此组件通过模块自己保存的那份 `pi` 访问宿主：

```js
import React from "react";

let host = null;

function InsertButton() {
  return React.createElement(
    "button",
    { onClick: () => host.dispatch("composer.insertText", { text: "hello" }) },
    "Insert",
  );
}

export function onLoad(pi) {
  host = pi;
  pi.slots.register({ slot: "composerControl", component: InsertButton, positions: ["right"] });
}
```

- `composerControl` —— 输入区工具栏上的控件；`positions: ["left"]` 或 `["right"]` 选择一侧，省略即两侧
- `composerTrigger` —— 输入区某个触发符背后的条目列表：`{ slot: "composerTrigger", trigger: "#", items }`，列表由宿主绘制
- `userAction` / `assistantAction` —— 消息操作栏上的条目
- `entryExtra` —— 助手回复下方的区块
- `toolCard` —— 自有 Agent 工具调用的卡片；用 `toolName` 指定工具
- `blockRenderer` —— 形如 `<你的插件id>:<lang>` 的代码块渲染器；`language` 指定标签

自绘弹窗不是插槽：`pi.ui.openLayer()` 交给你一个可以渲染的层，组件在其中绘制。样式通过
`pi.ui.injectStyle` 注入；`react` / `react-dom` 会通过窗口的 import map 解析到应用自带的副本，
不需要打包自己的 React。

`rendererActions` 限定组件可派发的动作——`plugin.call`、`composer.insertText`、
`composer.readDraft`、`composer.replaceDraft`、`attachments.add`、`attachments.list`、
`attachments.remove`，最多 16 个——`rendererCallMethods` 限定 `onRendererCall` 为
`plugin.call` 应答的方法名，最多 32 个。白名单之外的派发返回 `PLUGIN_ACTION_UNDECLARED`，
词表之外的词返回 `PLUGIN_ACTION_UNKNOWN`。模块与应用同文档、共用同一份 React，因此
`renderer.extension` 是高风险权限：只授予你信任的代码。

`examples/plugins/ui-slots-lab` 在每个插槽上都挂了一个样例。
`packages/plugin-sdk/src/renderer.ts` 里有类型和各插槽的 props，manifest 侧见
[规格 07-plugins/02 §3.2](spec/07-plugins/02-plugin-manifest-schema.md)。

### 6.13 模型 Provider 与 OAuth

通过 `provider.register` 和清单声明 Provider。宿主持有 Provider 行、API key 表单、
加密凭证和模型请求；插件不会收到用户在 Add Service 输入的 key。
完整 id 为 `plugin:<pluginId>:<id>`。分类和简介支持字符串或 `{ en, "zh-CN" }`。

```json
{
  "permissions": ["provider.register"],
  "contributes": {
    "providers": [{
      "id": "example",
      "name": "Example AI",
      "category": "Example services",
      "description": "Models from your Example account.",
      "baseUrl": "https://api.example.com/v1",
      "apiStyle": "chat_completions",
      "authKind": "api_key",
      "models": []
    }]
  }
}
```

空模型列表仅适用于提供 `baseUrl` 的 API-key Provider，宿主在保存 key 后发现模型。
其他情况应声明 1..64 个模型；不限制每个插件的 Provider 数量。支持的 API style 为
`chat_completions`、`opencode_go`、`responses`、`anthropic_messages`、
`google_generative_ai`、`openai_codex_responses`、`pi_messages`；认证类型为
`api_key`、`none`、`oauth`。

OAuth 还需要 `provider.oauth`、`baseUrl` 以及 `onProviderOAuth(request, { signal })`。
处理 `login` / `refresh`，返回 `{ accessToken, refreshToken?, expiresAt?, accountLabel?, headers? }`。
只有 refresh 会收到本项现有凭证。使用 `pi.providers.oauth.prompt` / `.notify` 展示宿主交互，
并响应取消。refresh token 不会进入渲染器或 Agent Runtime。令牌请求若走宿主网络 API，
仍需单独的 `net.fetch` 与出网声明。禁用插件保留并关闭 Provider 行；移除声明或卸载会删除行及凭证。

### 6.14 跟随会话、导入历史、读取用量

用 `pi.session.getActive()` 与 `session:activated` 跟随当前选择的会话，无需新增权限，
但仍受项目激活范围限制。离开聊天时返回 `null`，否则为 `{ sessionId, projectPath, activeTurn }`；
`activeTurn` 为 `null` 或 `{ turnId, startedAt }`。快照可能在 `await` 期间失效。

`session:turnEnded` 提供 `{ sessionId, turnId, reason }`，原因为 `completed`、`aborted`、`error`。
存活的插件每轮收到一次，事件不确认、不重放，也不保证所有迟到的工具已退出。
订阅与取消订阅应使用同一个函数引用。

```js
function onSession(snapshot) {
  if (!snapshot) return;
  console.log("Selected session", snapshot.sessionId);
}

async function onLoad() {
  pi.events.on("session:activated", onSession);
  onSession(await pi.session.getActive());
}

function onUnload() {
  pi.events.off("session:activated", onSession);
}

module.exports = { onLoad, onUnload };
```

历史管理使用独立的所有权边界。声明
`contributes.sessionSources: [{ id: "archive", label: "Archive" }]` 后，按需使用：

| 任务 | 方法 | 权限 |
|---|---|---|
| 导入历史 | `session.import`、`session.importBatch` | `session.import` |
| 读取自己导入的历史 | `session.list`、`get`、`listMessages` | `session.read.own` |
| 重命名自己导入的会话 | `session.rename` | `session.update.own` |
| 移入回收站或清除自己导入的会话 | `session.delete` | `session.delete.own` |
| 创建或复用显式项目绑定 | `project.create`；导入传 `projectId` | `project.create` |
| 生成默认标题 | `session.getAutoTitleContext`、`setAutoTitle` | `session.autoTitle` |
| 读取已完成轮次用量 | `usage.listTurns` | `usage.read` |

导入以 `(pluginId, source, externalId)` 幂等。时间必须为严格 RFC3339，消息时间单调递增，
后续调用使用宿主返回的 id。导入的 Provider、模型、路径只是历史元数据，不会自动建立实时绑定。
传现有 `projectId` 才绑定项目；创建项目不会切换工作区。宿主用 `sessionsChanged` 刷新界面。

读取与修改仅限自己导入的会话。批量 `skip` 逐项继续，`fail` 原子提交。
`trash` 保留正文和来源，`purge` 删除两者。没有通用消息修改或任意会话重绑定 API。
自动标题只暴露默认标题会话的首条提示词和回复摘要，通过 `expectedTitle` 比较更新，手动改名优先。
用量只含计数和标识，不含正文。载荷与上限见[会话 API 规范](/zh-CN/spec/07-plugins/03-plugin-api)。

### 6.15 模型目录与单次补全

`pi.models.list()`（`models.list`）返回已就绪的模型绑定，不含凭证。
将返回的 `key` 原样传给 `pi.agent.complete`（`agent.complete`），模型 id 自身可能包含 `/`。

```js
const models = await pi.models.list();
const model = models.find((item) => item.isDefault) ?? models[0];
if (!model) throw new Error("Configure a model first");
const answer = await pi.agent.complete({
  modelKey: model.key,
  system: "Answer briefly.",
  messages: [{ role: "user", content: "Explain this plugin's purpose." }],
});
await pi.ui.showToast(answer.text);
```

该 API 会消耗用户的 Provider 配额，不启用工具。认证、错误分类和有界重试由宿主持有。
上限为 90 秒、每插件滚动一分钟 8 次。`includeSessionContext` 还需 `session.read`，
且必须处于本插件 Agent 工具的有效调用中；`session.getLlmContext()` 同样如此。
后台服务、输入框转换、当前会话快照都不授予读取正文的能力。
处理 `TIMEOUT`、`RATE_LIMITED` 及 Provider 分类错误，避免无限重试。

### 6.16 输入框转换与建议

转换由用户主动触发，只收到 `{ id, text, modelKey? }`。声明
`contributes.composerTransforms` 和 `composer.transform` 后导出：

```js
function onComposerTransform({ id, text }) {
  if (id !== "trim") throw new Error("Unknown transform");
  return text.trim();
}

module.exports = { onComposerTransform };
```

在该贡献中声明 `{ "id": "trim", "title": "Trim draft", "undoTitle": "Undo trim" }`。
输入与输出各限 100,000 字符。宿主保留文件引用，丢弃编辑或切换会话后的过时结果，并提供撤销。
回调不会收到历史正文、附件数据或单独的文件路径元数据。

建议使用独立的主进程 API `pi.composer`，需要 `composer.suggest`，只在空草稿时显示占位提示，
不会发送消息。

```js
const active = await pi.session.getActive();
if (active) {
  const result = await pi.composer.suggest({
    sessionId: active.sessionId,
    turnId: active.activeTurn?.turnId,
    text: "Add a regression test for this change",
    ttlMs: 120_000,
  });
  if (!result.shown) console.log("Suggestion refused", result.reason);
}
// On your own cancellation path:
await pi.composer.clearSuggestion();
```

文本合并成一行并截为 200 字符；默认存活 120 秒，范围限制为 1..600 秒。
Tab 接受、Esc 忽略。输入、粘贴、附件、发送、切换会话、新轮次、卸载、渲染器重载或关窗都会清除。
正常拒绝返回 `{ shown: false, reason }`，原因为 `session-not-visible`、`draft-not-empty`、
`stale-turn`、`replaced`、`unsupported`；非法输入或缺少权限仍抛错。
若由 `session:turnEnded` 触发生成，传该事件的 `turnId`，避免迟到的补全干扰新轮次。

### 6.17 系统快捷键、WebSocket、麦克风与语音

系统快捷键独立于应用内 `shortcut` 设置。在 `contributes.globalShortcuts` 中声明 id 与自己的命令，
申请 `keyboard.globalShortcut`，并在 `onLoad` 注册命令。`default` 在加载后注册；运行时通过
`pi.keyboard.registerGlobalShortcut` 修改。检查返回的 `registered` / `error`，冲突返回
`registered: false` 而非抛错。卸载、禁用、崩溃都会释放，最多每插件 8 条。

WebSocket 需要 `net.websocket`，使用与 fetch 相同的出网策略。通过
`pi.net.websocket.connect` / `send` / `close` 操作，订阅完整名称
`net:websocket:open`、`net:websocket:message`、`net:websocket:close`、`net:websocket:error`，
事件包含所属 `socketId`。上限为 4 个连接、1 MiB 帧、4 MiB 待发送队列，随插件释放。

`ui.microphone` 仅允许隔离面板用 `getUserMedia` 获取音频，摄像头仍拒绝。
后台 `pi.audio.*` 有类型和权限门，但**尚无设备后端**，授权后仍返回或抛出 `UNSUPPORTED`。
不能仅凭清单声明实现后台录音。

`pi.speech.registerAdapter` / `unregisterAdapter`（`speech.adapter.register`）添加协议处理器，
返回文本、音频或宿主执行的 HTTP 计划。`openai_audio`、`openai_chat_audio` 是保留 id；
携带绑定 Provider key 的 HTTP 计划只能访问该 Provider origin。

### 6.18 浏览器与桌面操作

`fs.openInBrowser(path)` 只需 `fs.read`，将现有可读 HTML 打开为工作面板资源页，不授予浏览器自动化。
自动化使用 `browser.cdp` 与 `pi.browser.*`；工具调用绑定发起会话，后台会话不能重定向前台页面。
CDP 使用允许列表，Cookie、存储、目标管理、网络拦截仍拒绝。`browser.reveal()` 只负责显式展示，
后台导航无需先调用它。整页截图按比例缩至最多 1280×2048，捕获超时 30 秒。

`desktop.control` 通过 `pi.desktop.listOperations()` 与
`pi.desktop.invoke({ operation, args, confirm? })` 访问审定目录，不开放任意 IPC。
危险操作同时需要 `confirm: true` 和宿主原生对话框中的用户确认。
会话协作的 `spawn` / `send` 还要求有效的插件 Agent 工具调用，来源会话与轮次由宿主注入。
在创建、发消息、取消或删除会话前，请读[桌面控制契约](/zh-CN/spec/07-plugins/03-plugin-api)。

## 7. 权限设计

权限均在 `manifest.json` 中声明并由用户授予。
未声明或未授予的 API 调用失败并显示 `PERMISSION_DENIED`。

| 风险 | 权限 |
|---|---|
| 低 | `ui.panel`, `ui.view`, `ui.theme`, `ui.settings`, `ui.window.appearance`, `notify` |
| 中等 | `ui.microphone`, `clipboard.read`, `clipboard.write`, `fs.read`, `composer.transform`, `composer.suggest`, `models.list`, `session.read.own`, `session.update.own`, `usage.read`, `shell.openExternal`, `background.service`, `bus.publish`, `bus.subscribe`, `audio.playback.background`, `keyboard.globalShortcut` |
| 高 | `fs.write`, `fs.delete`, `agent.tool.register`, `agent.prompt.inject`, `agent.complete`, `agent.extension`, `renderer.extension`, `provider.register`, `provider.oauth`, `desktop.control`, `project.create`, `session.read`, `session.import`, `session.delete.own`, `session.autoTitle`, `net.fetch`, `net.anyHost`, `mcp.server.local`, `mcp.server.remote`, `browser.cdp`, `audio.capture.background`, `speech.adapter.register`, `net.websocket` |

`keyboard.globalShortcut` 与 `net.websocket` 已实现。`pi.audio.*` 已经存在并且
可以调用，其方法仍由权限把关，但当前宿主还没有设备后端：获得授权的调用会以
带错误码的 `UNSUPPORTED` 拒绝并记入审计，`onInputFrame` / `offInputFrame` 则
同步抛出同一个错误码，直到设备服务落地并用真实的采集与播放取代这个拒绝。

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

自动重载不会扩大授权或文件范围。若保存后被权限门拒绝，可在插件行的 **More → Reload**
中显式审核并重新加载已登记目录，或再次加载开发目录。删除权限会立即生效。

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

## 9. 检查、打包、安装

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

打包还会跳过凭证文件（`.env`、`.env.*`、`.npmrc`、`*.pem`、`*.key`）并给出警告。
产物仍必须检查和实际安装，`check` 不证明运行时、兼容版本、授权、网络或中心审核一定成功。

### 用 `pi-plugin publish` 准备插件中心提交

`publish` 会打包插件，并把包固定到构建它的 git 提交上，
以便插件中心能够重新构建并比对工件：

`publish` 仅在本地准备包和提交 JSON，不会上传或发布。先将 `dist/` 加入插件仓库的
`.gitignore`，因为打包发生在干净工作区检查之前。

```bash
pnpm pi-plugin publish ../my-first-plugin [--out <dir>] [--ref <ref>] [--channel stable|beta] [--allow-dirty]
```

该命令先执行与 `check`、`pack` 相同的步骤，然后读取插件仓库的 `origin`
远程和 `HEAD`。SSH 远程会被改写为规范的 `https://` 形式；内嵌凭据或
非 HTTPS 协议的远程会被拒绝。除非传入 `--allow-dirty`，否则工作树必须干净；
传入后生成的提交无法被插件中心复现，并会打印警告。固定的 `ref` 优先取
`--ref`，否则取指向 `HEAD` 的标签（写成 `refs/tags/<tag>`）；没有标签时提交裸
commit 并给出警告。插件相对仓库根目录的路径也会被记录，因此插件可以位于子目录中。

结果是 `dist/<id>-<version>.submission.json`（或 `--out` 指定的目录），一个
`schemaVersion: 1` 的载荷，包含 `pluginId`、`version`、`channel`、`source`
固定信息（`repository`、`ref`、`commit`、`path`）、`artifact`（`publisher-release`
模式、文件名、SHA-256、大小）、声明的 `permissions`，以及按插件、版本、提交和工件
稳定的 `idempotencyKey`，因此重试提交不会成为新的发布。把 `.piplug` 附到该提交
的 release 上，再把载荷提交给插件中心。插件中心会从代码托管平台重新解析来源，
不信任载荷中记录的值。

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

官方市场的发布走插件中心 [plugins.aiuo.net](https://plugins.aiuo.net)：创建插件、绑定插件所在的仓库、
给版本打标签并提交——可以在控制台操作，也可以用发布 skill 走 MCP。平台负责打包、审查源码、记录
SHA-256 并发布该版本，再把目录与安装包同步到
[AIUO-Net/pi-desktop-plugins](https://github.com/AIUO-Net/pi-desktop-plugins) 作为 GitHub 备用通道。
分发仓库不托管插件源码，向它提交「新增插件源码」的 PR 会被关闭。

当前使用包 SHA-256 和显式
权限审核作为信任基线，后续规划见
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

## 12. 参考索引

- [示例插件](https://github.com/vastsa/PI-Desktop/tree/main/examples/plugins)
- [插件系统概述](/zh-CN/spec/07-plugins/01-plugin-system)
- [Manifest Schema](/zh-CN/spec/07-plugins/02-plugin-manifest-schema)
- [主机 API](/zh-CN/spec/07-plugins/03-plugin-api)
- [生命周期](/zh-CN/spec/07-plugins/05-plugin-lifecycle)
- [包装](/zh-CN/spec/07-plugins/06-plugin-packaging)
- [开发者体验](/zh-CN/spec/07-plugins/10-plugin-devex)
- [权限](/zh-CN/spec/07-plugins/13-plugin-permissions-matrix)
- [Hello 参考插件](https://github.com/vastsa/PI-Desktop/tree/main/examples/plugins/hello)

## 13. 完整 SDK 接口与源码索引

下表逐项对应 `packages/plugin-sdk/src/index.ts` 的 `PluginHostApi`，是方法索引，不代表已授权。
权限、调用上下文和可用性限制仍适用，`pi.audio` 仍未实现设备后端。
面板桥是较小的接口集合，见 API 规范 §6。

| 命名空间 | 方法 |
|---|---|
| `pi.app` | `getVersion`, `getLocale`, `getAppearance`, `setTheme` |
| `pi.themes` | `upsert`, `remove`, `list`, `setVariables` |
| `pi.plugin` | `getId`, `getManifest`, `getSettings`, `setSettings`, `getDataPath` |
| `pi.commands` | `register`, `unregister` |
| `pi.speech` | `registerAdapter`, `unregisterAdapter` |
| `pi.composer` | `suggest`, `clearSuggestion` |
| `pi.ui` | `openPanel`, `closePanel`, `showToast`, `notify`, `getNotificationPermission`, `requestNotificationPermission`, `showNativeNotification`, `revealView` |
| `pi.project` | `create` |
| `pi.providers.oauth` | `prompt`, `notify` |
| `pi.workspace` | `get` |
| `pi.desktop` | `listOperations`, `invoke` |
| `pi.audio` | `getInputDevices`, `openInput`, `closeInput`, `getCaptureState`, `onInputFrame`, `offInputFrame`, `openOutput`, `writeOutput`, `stopOutput`, `closeOutput` |
| `pi.keyboard` | `registerGlobalShortcut`, `unregisterGlobalShortcut`, `listGlobalShortcuts` |
| `pi.fs` | `readText`, `stat`, `readRange`, `readPreview`, `openDefault`, `openInBrowser`, `reveal`, `writeText`, `glob`, `list`, `remove`, `requestDirectory` |
| `pi.agent` | `registerTool`, `unregisterTool`, `complete` |
| `pi.models` | `list` |
| `pi.session` | `getLlmContext`, `getActive`, `getAutoTitleContext`, `setAutoTitle`, `list`, `get`, `listMessages`, `import`, `importBatch`, `rename`, `delete` |
| `pi.usage` | `listTurns` |
| `pi.services` | `register`, `unregister` |
| `pi.bus` | `publish`, `subscribe` |
| `pi.clipboard` | `readText`, `writeText`, `getHistory` |
| `pi.shell` | `openExternal` |
| `pi.browser` | `reveal`, `navigate`, `action`, `setBounds`, `setVisible`, `getState`, `openExternal`, `snapshot`, `screenshot`, `click`, `fill`, `evaluate`, `console`, `cdp` |
| `pi.net` | `getCapabilities`, `fetch` |
| `pi.net.websocket` | `connect`, `send`, `close` |
| `pi.events` | `on`, `off` |

渲染器模块的 `pi` 是另一套接口：`plugin.id` / `version`、`slots.register`、
`ui.injectStyle`、`ui.openLayer`、`composer.subscribeDraft`、`dispatch`。
订阅草稿需要在 `rendererActions` 声明 `composer.readDraft`；替换草稿需使用捕获的
`generation` 作为 `expectedGeneration` 防止过时写入，要求用户输入事件、Composer 未聚焦，并保留全部宿主 chip。具体载荷见 `renderer-composer.ts`，不能访问宿主 store。
没有用于直接发送消息的 renderer action。

源码核对入口：`packages/plugin-sdk/src`（类型与校验）、`packages/plugin-devkit/src`
（模板、检查、打包、提交准备）、`crates/host-core/src/plugins`（安装与持久化）、
`apps/desktop/electron/main/plugin-runtime.ts` 与 `plugin-host-process.mjs`（实际分发与生命周期）、
`apps/desktop/electron/preload/plugin-panel.ts`（面板桥）、`apps/desktop/test/plugin-*.test.mjs`（验证）。
示例位于 `examples/plugins/{hello,ui-slots-lab,fetch-redirect,roundtable}`。

`docs/plugin-plan` 包含评审材料和规划中的运行时钩子，draft 页面不是已实现的 SDK 导出。
判断能力是否存在时，以 SDK 与实际运行时为准。应用内置开发说明位于
`apps/desktop/resources/skills/plugin-development.md`。
