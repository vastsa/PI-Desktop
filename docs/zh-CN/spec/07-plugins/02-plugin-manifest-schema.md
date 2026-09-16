# 02. 插件Manifest Schema

> **翻译说明：** 本页是与 [英文源规格](/spec/07-plugins/02-plugin-manifest-schema) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. 目的

冻结插件清单字段以保证：

- 主机可以验证
- 开发人员可以依赖它
- 未来版本可以迁移

架构版本：`1`

## 2. 根对象

```ts
type PluginManifestV1 = {
 schemaVersion: 1;
 id: string; // ^[a-z0-9]+(\.[a-z0-9_-]+)+$
 name: string;
 version: string; // semver
 description?: string;
 author?: string | { name: string; url?: string; email?: string };
 homepage?: string;
 repository?: string;
 icon?: string; // relative path
 main?: string; // plugin runtime entry
 ui?: PluginUiConfig;
 contributes?: PluginContributes;
 permissions?: PluginPermission[];
 fs?: PluginFsPolicy; // 每个文件权限可以触碰哪些路径（§5.2）
 net?: { domains?: string[] }; // 出网白名单（§5.3）
 engines?: {
 piDesktop?: string; // semver range
 };
 entrypoints?: {
 onInstall?: string;
 onLoad?: string;
 onEnable?: string;
 onDisable?: string;
 onUnload?: string;
 onUninstall?: string;
 };
 activationEvents?: string[]; // e.g. onCommand:xxx / onStartup
 /**
  * 随应用打包插件的首次注册默认值。省略表示启用。
  * 市场安装和开发加载仍在用户授权后启用。
  */
 enabledByDefault?: boolean;
};
```

## 3. 用户界面配置

```ts
type PluginUiConfig = {
 panel?: string; // html entry
 width?: number;
 height?: number;
 resizable?: boolean;
 title?: string;
};
```

## 4. 贡献

```ts
type PluginContributes = {
 commands?: PluginCommandContrib[];
 agentTools?: PluginAgentToolContrib[];
 skills?: Array<string | PluginSkillContrib>; // relative paths, or metadata overrides
 agentExtensions?: string[]; // 在 agent sidecar 内运行的 ExtensionAPI 模块；需要 `agent.extension`（规格 16）
 providers?: PluginProviderContrib[]; // 宿主拥有的 provider 行；需要 `provider.register`（规格 13）
 settings?: PluginSettingContrib[];
 themes?: PluginThemeContrib[];
 windowAppearance?: PluginWindowAppearanceContrib; // 原生窗口背景；需要 `ui.window.appearance`
 permissionDeny?: PluginPermissionDenyContrib; // deny-first 叠加；需要 `agent.permission.deny`
 mcpServers?: PluginMcpServerContrib[];
 services?: PluginServiceContrib[];
  bus?: PluginBusContrib;
  views?: PluginViewContrib[];
  sessionSources?: PluginSessionSourceContrib[];
  globalShortcuts?: PluginGlobalShortcutContrib[]; // 需要 `keyboard.globalShortcut`
};

type PluginCommandContrib = {
 id: string; // plugin-local or fully-qualified
 title: string;
 keywords?: string[];
 category?: string;
 icon?: string;
 requires?: PluginPermission[]; // extra per-command perms
};

type PluginAgentToolContrib = {
 name: string; // tool name exposed to agent
 description: string;
 risk: "low" | "medium" | "high";
 schema: Record<string, unknown>; // JSON schema object
 timeoutMs?: number;
 permissions?: PluginPermission[];
};

type PluginSettingContrib = {
 key: string;
 title: string;
 description?: string;
 type: "string" | "number" | "boolean" | "select" | "json" | "shortcut";
 default?: unknown;
 enum?: Array<{ label: string; value: string | number | boolean }>;
 command?: string; // shortcut 设置调用这个已声明的插件命令
 scope?: "plugin"; // 暂不支持全局插件快捷键
 secret?: boolean;
};

type PluginViewContrib = {
 id: string; // ^[a-zA-Z][a-zA-Z0-9_-]{0,63}$，插件内唯一
 title: string | { en: string; "zh-CN": string };
 icon?: string; // 宿主图标集中的 token；未知 token 渲染为字母瓷砖
 entry: string; // 视图 HTML 入口的相对路径
  order?: number; // 插件视图分组内的升序排序键，默认 0
};

type PluginSessionSourceContrib = {
 id: string; // ^[a-zA-Z][a-zA-Z0-9._-]{0,63}$，插件内唯一
 label?: string | { en: string; "zh-CN": string };
};

/** 插件声明的一个系统级快捷键（`keyboard.globalShortcut`）。 */
type PluginGlobalShortcutContrib = {
 id: string; // ^[a-zA-Z][a-zA-Z0-9._-]{0,63}$，插件内唯一
 command: string; // 必须声明在 contributes.commands 里
 default?: string; // 宿主在加载后注册的加速键；省略则由 `pi.keyboard` 稍后注册
};

type PluginThemeContrib = {
 id: string; // ^[a-zA-Z][a-zA-Z0-9_-]{0,63}$
 label: string;
 path: string; // relative `.css` file
 base?: "light" | "dark"; // palette the overrides layer on, default `dark`
 assets?: string[]; // 绝对路径的 png/jpg/jpeg/webp/avif/svg/woff2，总和上限 4 MB；
                    // 命中的 `url()` 会被改写为 `plugin-asset://`
};

type PluginWindowAppearanceContrib = {
 backgroundColor?: { light?: string; dark?: string }; // #rrggbb | #rrggbbaa
};

type PluginPermissionDenyContrib = {
 tools?: string[]; // 对工具名的 glob
 paths?: string[]; // 对 path / file_path 的 glob；~ 会展开
 commands?: string[]; // 仅 Bash：glob 或前缀
};

type PluginSkillContrib = {
 id?: string; // defaults to the file name without its extension
 path: string; // relative path to the skill document
 name?: string; // overrides the front-matter `name`
 description?: string; // overrides the front-matter `description`
};

type PluginMcpServerContrib = {
 id: string; // ^[a-zA-Z][a-zA-Z0-9_-]{0,63}$
 label?: string;
 transport: "stdio" | "http";
 // stdio only
 command?: string; // bare PATH name, or plugin-relative executable
 args?: string[];
 env?: Record<string, string | { setting: string }>;
 // 远程 HTTP 传输
 url?: string; // 绝对 http(s) 端点；HTTP 可以指向可信的局域网主机
 headers?: Record<string, string | { setting: string }>;
};

type PluginServiceContrib = {
 id: string; // ^[a-zA-Z][a-zA-Z0-9_-]{0,63}$
 label?: string;
 autoRestart?: boolean; // default true
};

type PluginBusContrib = {
 publish?: string[]; // concrete topics, e.g. `build.done`
 subscribe?: string[]; // patterns, e.g. `build.*` / `build.**`
};

type PluginProviderContrib = {
 id: string; // ^[a-zA-Z][a-zA-Z0-9_-]{0,63}$，插件内唯一
 name: string; // 原生 provider 列表中的显示名
 vendorKey?: string; // models.dev 供应商键，默认 `custom`
 baseUrl?: string; // 绝对 http(s) URL
 apiStyle?: PluginProviderApiStyle; // 线路风格，默认 `chat_completions`
 authKind?: "api_key" | "none"; // 默认 `api_key`；`oauth` 暂被拒绝
 models: PluginProviderModelContrib[]; // 1..64 条
};

type PluginProviderApiStyle =
 | "chat_completions"
 | "opencode_go"
 | "responses"
 | "anthropic_messages"
 | "google_generative_ai"
 | "openai_codex_responses"
 | "pi_messages";

type PluginProviderModelContrib = {
 id: string; // 1..256 个字符，provider 内唯一
 name?: string; // 模型绑定的显示标签
 contextWindow?: number;
 maxTokens?: number;
 supportsImages?: boolean;
};
```

## 5. 权限枚举

```ts
type PluginPermission =
 | "ui.panel"
 | "ui.view"
 | "ui.theme"
 | "ui.window.appearance"
 | "clipboard.read"
 | "clipboard.write"
 | "notify"
 | "fs.read"
 | "fs.write"
 | "fs.delete"
 | "agent.tool.register"
 | "agent.prompt.inject"
 | "agent.permission.deny"
 | "provider.register"
 | "net.fetch"
 | "shell.openExternal"
 | "mcp.server.local"
 | "mcp.server.remote"
 | "background.service"
 | "bus.publish"
 | "bus.subscribe"
 | "browser.cdp"
 | "desktop.control"
 | "ui.microphone"
 | "project.create"
 | "session.import"
 | "session.read.own"
 | "session.update.own"
 | "session.delete.own"
 | "audio.capture.background"
 | "audio.playback.background"
 | "keyboard.globalShortcut"
 | "net.websocket";
```

未知权限=验证失败。

`fs.read.workspace`、`fs.write.workspace`、`fs.delete.workspace` 是文件范围机制
之前的旧权限名。它们仍然能通过校验，主机会在加载时把它们改写成最小安全等价物
（§5.2）；新的清单不得再使用。

## 5.2 fs —— 文件权限可以触碰哪些路径

```ts
type PluginFsPolicy = {
 read?: PluginFsRule;
 write?: PluginFsRule;
 delete?: PluginFsRule;
};

type PluginFsRule = {
 root?: "workspace" | "userSelected"; // 默认 `workspace`
 scope?: string[]; // 相对 root 的 glob
 own?: boolean; // 仅删除：这个插件写过的路径
};
```

权限回答的是「这个插件能不能碰文件」，这里回答的是「能碰哪些文件」。
glob 里 `*` 匹配一个路径段，`**` 跨分隔符匹配，并以大小写不敏感的方式
与相对 root 的路径比较。

```json
{
 "permissions": ["fs.read", "fs.write", "fs.delete"],
 "fs": {
 "read": { "root": "workspace", "scope": ["**/*"] },
 "write": { "root": "workspace", "scope": ["docs/**", "*.md"] },
 "delete": { "own": true, "scope": ["dist/**"] }
 }
}
```

- 没有 `fs` 块、缺少某个模式、或 `scope` 为空都是合法的，含义是**没有常驻
  可达范围**：每次访问都落到运行时确认 —— 什么都不说就什么都不授予
- `root: "userSelected"` 不需要 scope —— 用户通过 `pi.fs.requestDirectory()`
  亲手选的目录本身就是授权，它只存在于内存中，并随插件进程一起消失
- `own` 只在 `delete` 上被接受

## 5.3 net —— 出网白名单

```ts
type PluginNetDomains = string[]; // "api.example.com" 或 "*.example.com"
```

主机掌握的每一条出网路径 —— 面板 session、`pi.net.fetch`、远程 HTTP MCP
端点 —— 都被限定在这些主机名之内。列表缺失、为空或非法就完全不放行出网，
无论 `net.fetch` 怎么声明。条目是裸主机名：没有 scheme、没有端口、没有路径，
也不允许裸 `*`。前缀 `*.` 同时覆盖该域名及其子域名。

`pi.net.websocket` 听同一份列表（`net.websocket`，
[03-plugin-api.md](/zh-CN/spec/07-plugins/03-plugin-api) §3）。该权限已实现：
连接被限定在 `manifest.net.domains` 之内，未被声明的主机会在传输被要求
打开任何东西之前就被拒绝。

## 5. 1 总线主题语法

主题最多是与 `[a-zA-Z0-9][a-zA-Z0-9_-]*` 匹配的点分隔段
8段128个字符。 `contributes.bus.publish` 列出了具体主题；
`contributes.bus.subscribe` 列出 `*` 与一个段完全匹配的模式
`**` 匹配一个或多个尾随段（仅最后一个段）。

```json
{
 "bus": {
 "publish": ["build.done"],
 "subscribe": ["build.*", "deploy.**"]
 }
}
```


## 5.4 providers —— 插件声明的 provider 行

`contributes.providers` 最多声明 8 个 provider，宿主会把每一项落成原生 provider
列表中的一行，并归该插件所有（[ADR 0259](../../../adr/0259-plugin-declared-providers.md)）：

- 声明的 `id` 匹配 `[a-zA-Z][a-zA-Z0-9_-]{0,63}` 且在插件内唯一；行 id 为
  `plugin:<pluginId>:<declaredId>`
- `name` 必填，是设置页显示的名称
- `baseUrl` 可选，但必须是绝对 `http(s)` URL
- `apiStyle` 可选，默认 `chat_completions`；可取值是 provider 配置中除 `auto`
  以外的风格
- `authKind` 可选，为 `api_key`（默认）或 `none`
- `models` 要求 1..64 条，id 唯一且长度为 1..256

非空的 `contributes.providers` 需要高风险权限 `provider.register`
（[13-plugin-permissions-matrix.md](/zh-CN/spec/07-plugins/13-plugin-permissions-matrix)）。
声明会在每次插件加载时重新读取，并对其自身字段具有权威；禁用插件会保留这些行并
将其关闭，而删除声明或卸载插件会连同已存凭据一起删除该行。

`oauth` **暂不支持**：宿主还没有插件 OAuth 登录流程，因此 `oauth` 块或
`authKind: \"oauth\"` 会在清单元数据校验阶段被拒绝。计划中的 `provider.oauth`
权限与宿主自有的登录流程属于未来工作，当前不可用。
## 6. activationEvents（可选）

示例：

- `onStartup`
- `onCommand:demo.hello.say`
- `onAgentMode`
- `onWorkspaceOpen`

MVP 只能实现：
- `onStartup`
- `onCommand:*`

## 7. 验证规则

1. `schemaVersion` 必须是 `1`
2. 需要 `id` / `name` / `version`
3. 声明 `ui.panel` 的清单是否需要隐式（自动填充）或通过显式声明获得 `ui.panel` 权限是一个 **悬而未决的问题**（在 [08-meta/open-questions.md](/zh-CN/spec/08-meta/open-questions) 中跟踪）
4. 如果存在 `agentTools`，则必须声明 `agent.tool.register`
5. 路径字段不得使用绝对路径或 `..`
6. `main` / `ui.panel` / 技能 / `views[].entry` 路径必须存在
7.工具`name`仅允许`[a-zA-Z][a-zA-Z0-9_]*`
8. 贡献 ID（`themes`、`mcpServers`、`services`、`views`）必须匹配
   `[a-zA-Z][a-zA-Z0-9_-]{0,63}` 并在自己的列表中保持唯一；
   `sessionSources` 允许额外使用 `.`
9. `themes[].path` 必须存在且以 `.css` 结尾； `themes[].base` 可能只是
   `light` 或 `dark`
10. `mcpServers[]` 必须准确设置一个传输字段：`stdio` 要求
   `command`（裸路径名称或插件相对，从不绝对）并拒绝 `url`/`headers`；
   `http` 需要绝对的 `http` 或 `https` `url`，并拒绝
   `command`/`args`/`env`。非回环 HTTP 不加密，必须声明在 `net.domains` 中。
11. `bus.publish` 条目必须是具体主题，`bus.subscribe` 条目必须是具体主题
   有效模式（§5.1）
12. 需要权限的贡献在权限验证时失败
   缺少：`themes` → `ui.theme`，`views` → `ui.view`，`providers` →
   `provider.register`，stdio 服务器 → `mcp.server.local`，远程
   服务器 → `mcp.server.remote`、`services` → `background.service`、
   `bus.publish` → `bus.publish`，`bus.subscribe` → `bus.subscribe`，
   `permissionDeny` → `agent.permission.deny`（包括空 `{}`）。
`skills` 是一个例外 - 它早于权限门，因此清单
   没有 `agent.prompt.inject` 仍然有效并且运行时只是跳过
   技能
13. 设置的 key 必须唯一。`shortcut` 设置必须带 `command`，只能用 `plugin`
    作用域，并按「修饰键 + 按键」或 F 键校验。在安全的插件密钥存储出现之前，
    secret 一律拒绝
14. `fs.<mode>` 需要对应的 `fs.<mode>` 权限 —— 没人能用的范围是作者的笔误，
    不是静默的空操作。scope 条目必须是相对路径（不得是绝对路径、盘符或 `..`），
    并且 `fs.write` / `fs.delete` 不得使用整棵树的模式（`**`、`**/*`、`*/**`、
    `./*`）。`own` 只在 `delete` 上被接受，`root` 只能是 `workspace` /
    `userSelected`
15. `net.domains` 条目必须是裸主机名，可选前缀 `*.`；裸 `*` 会被拒绝
16. `views[].title` 必填；使用本地化对象时必须同时提供 `en` 与 `zh-CN`。
    `views[].icon` **不**按 token 列表校验：未知 token 会降级为字母瓷砖，
    为一个纯外观细节拒绝插件并不合理。打包检查会改为给出警告
17. `sessionSources` id 必须匹配 `[a-zA-Z][a-zA-Z0-9._-]{0,63}` 且不能重复；
    本地化 label 必须同时提供 `en` 和 `zh-CN`
18. `contributes.globalShortcuts` 最多允许 8 条，且需要
   `keyboard.globalShortcut`。每个 `id` 匹配
   `[a-zA-Z][a-zA-Z0-9._-]{0,63}` 且唯一；`command` 必须声明在
   `contributes.commands` 里；`default` 若存在，使用与 `shortcut` 设置相同的
   修饰键加按键 / F 键语法

## 8. 示例：最小插件

```json
{
 "schemaVersion": 1,
 "id": "demo.hello",
 "name": "Hello",
 "version": "0.1.0",
 "main": "main.js",
 "ui": {
 "panel": "renderer/index.html"
 },
 "contributes": {
 "commands": [
 {
 "id": "hello.open",
 "title": "Open Hello Panel",
 "keywords": ["hello"]
 }
 ]
 },
 "permissions": ["ui.panel"]
}
```

## 9. 示例：Agent 工具插件

```json
{
 "schemaVersion": 1,
 "id": "demo.echo-tool",
 "name": "Echo Tool",
 "version": "0.1.0",
 "main": "main.js",
 "contributes": {
 "agentTools": [
 {
 "name": "echo_text",
 "description": "Echo a text value",
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

## 9. 1 示例：能力贡献

```json
{
 "schemaVersion": 1,
 "id": "demo.capabilities",
 "name": "Capabilities",
 "version": "0.1.0",
 "main": "main.js",
 "contributes": {
 "skills": [{ "path": "skills/release.md", "id": "release-notes" }],
 "themes": [
 { "id": "midnight", "label": "Midnight", "path": "themes/midnight.css", "base": "dark" }
 ],
 "mcpServers": [
 {
 "id": "docs",
 "transport": "stdio",
 "command": "npx",
 "args": ["-y", "@example/docs-mcp"],
 "env": { "DOCS_TOKEN": { "setting": "docsToken" } }
 },
 {
 "id": "issues",
 "transport": "http",
 "url": "https://mcp.example.com/issues",
 "headers": { "Authorization": { "setting": "issuesAuth" } }
 }
 ],
 "services": [{ "id": "watcher", "label": "Repo watcher" }],
 "bus": { "publish": ["demo.build.done"], "subscribe": ["demo.**"] }
 },
 "permissions": [
 "agent.prompt.inject",
 "ui.theme",
 "mcp.server.local",
 "mcp.server.remote",
 "background.service",
 "bus.publish",
 "bus.subscribe"
 ]
}
```

`{ "setting": "<key>" }`读取插件自身的设置；宿主环境是
从未通过（D018）。

## 10. 兼容性策略

- 未来的 `schemaVersion: 2` 需要迁移器
- 主机应拒绝过高的主要版本
- 未知的可选字段可能会被忽略；未知所需的权限必须失败
