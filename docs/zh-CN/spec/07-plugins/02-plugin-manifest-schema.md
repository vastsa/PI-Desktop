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
 /**
  * Display strings per locale, shown in place of `name`/`description` when the
  * shell's language matches one of the declared locales (see §3.1). The flat
  * fields stay the author's own language and remain the fallback.
  */
 i18n?: {
   [locale: string]: {
     name?: string;
     description?: string;
     safetyNotes?: string;
   };
 };
 repository?: string;
 icon?: string; // relative path
 main: string; // required plugin runtime entry
 renderer?: string; // module the host evaluates to mount UI slots (§3.2)
 rendererActions?: string[]; // actions a renderer component may dispatch, at most 16
 rendererCallMethods?: string[]; // onRendererCall methods plugin.call may reach, at most 32
 ui?: PluginUiConfig;
 contributes?: PluginContributes;
 permissions?: PluginPermission[];
 fs?: PluginFsPolicy; // which paths each file permission may touch (§5.2)
 net?: { domains?: string[] }; // egress allowlist (§5.3)
 engines?: {
 piDesktop?: string; // semver range
 };
 activationEvents?: string[]; // e.g. onCommand:xxx / onStartup
 /**
  * First-registration default for bundled plugins. Omitted means enabled.
  * Marketplace and development installs still enable after the user grants
  * permissions.
  */
 enabledByDefault?: boolean;
};
```

SDK 的 `author` 接受字符串或联系对象，但当前 Rust 安装器把它反序列化为字符串，
可安装的包应使用显示字符串。SDK 与宿主校验不完全相同：两者都要求 `main`，
但 schema 版本和元数据检查有差异。编写 `schemaVersion: 1`，先 `check` 再安装实际包，
不能把底层解析器较宽松的行为当成兼容性承诺。

## 3. 用户界面配置

```ts
type PluginUiConfig = {
 panel?: string; // html entry
 width?: number;
 height?: number;
 shape?: "panel" | "widget";
 alwaysOnTop?: boolean;
 resizable?: boolean;
 title?: string | {
   en: string;
   "zh-CN": string;
 }; // localized native panel identity; both locales are required for an object
};
```

### 3.1 多语言标签（`i18n`）

`name`、`description` 和 `safetyNotes` 都是展示文案，插件可以用顶层 `i18n` 块按
locale 声明。扩展页、插件启动器和市场（从 catalog 条目读取同一个块）显示的是**应用
语言**对应的条目，而不是作者自己写的那一种：

```json
{
  "name": "小清新待办",
  "description": "作者原话",
  "i18n": {
    "en": { "name": "Todo List", "description": "A calm todo list" },
    "zh-CN": { "name": "小清新待办", "description": "轻盈的待办清单", "safetyNotes": "只写自己的数据" }
  }
}
```

规则：

1. `en` 与 `zh-CN` 是契约 locale。所有中文壳 locale（`zh`、`zh-CN`、`zh-Hans`、
   `zh-SG`）读 `zh-CN`，其余读 `en`。插件不必为其他已发布壳 locale 提供翻译，
   因此 `zh-TW` 读英文，而不是拿半份 `zh-CN` 猜测（ADR 0182）。
2. 插件仓库的校验器要求两个 locale 与三个字段齐全，但宿主是宽容的：缺 locale、
   缺字段或空字符串会按字段依次回退到另一个契约 locale，再回退到作者扁平的
   `name` / `description`。
3. 解析发生在宿主里，依据桌面壳下发的语言（`settings.language`，为 `auto` 时是
   系统语言）。存储行保留作者原文，因此切换语言只改变读取结果，绝不改写注册表。
4. 该块是展示元数据。格式错误（不是 locale → 对象的对象）会让 manifest 校验失败；
   条目里未知的 locale 与未知字段一律忽略。
5. 该块只服务身份文案（`name`、`description`、`safetyNotes`）。插件自有文案——面板、
   视图、widget、生成式设置、toast、运行时命令标题——不在这里翻译。宿主只发布当前
   语言（`pi.app.getLocale`、`appearance:changed`），由插件自行本地化（ADR 0280）。

### 3.2 渲染模块（`renderer`）

`renderer` 指向包内的一个 ES 模块，宿主会在自己的窗口中求值它，用来挂载 UI 插槽组件：

- `composerControl` —— 输入区工具栏上的附加控件
- `composerTrigger` —— 输入区某个触发符背后的条目列表（是数据不是组件：列表由宿主绘制）
- `userAction` / `assistantAction` —— 消息操作栏左右两侧的附加项
- `entryExtra` —— 助手回复下方的附加区块
- `toolCard` —— 插件自有 Agent 工具调用的卡片
- `blockRenderer` —— 形如 `<pluginId>:<lang>` 的代码块的渲染器

`pi.slots.register` 返回一个注销函数，插件卸载时所有注册都会被撤销。自绘弹窗不是插槽：
插件用 `pi.ui.openLayer` 打开一个层并在其中绘制（`docs/plugin-plan/ui/`）。

模块与宿主同文档运行，因此这是契约而不是沙箱边界；真正把组件限制在自己插件内的，是两份白名单。
`rendererActions` 列出组件可以派发的动作，最多 16 个，取自固定词表 `plugin.call`、
`composer.insertText`、`composer.readDraft`、`composer.replaceDraft`、`attachments.add`、
`attachments.list`、`attachments.remove`——词表之外返回 `PLUGIN_ACTION_UNKNOWN`，
词表之内但未声明的返回 `PLUGIN_ACTION_UNDECLARED`。`rendererCallMethods` 列出插件的
`onRendererCall` 为 `plugin.call` 应答的方法名，最多 32 个；宿主会注入调用方插件 id，
因此组件只能触达自己的插件。

```json
{
  "permissions": ["renderer.extension"],
  "renderer": "renderer/index.mjs",
  "rendererActions": ["plugin.call", "composer.insertText"],
  "rendererCallMethods": ["openWorkspace"]
}
```

插槽名、属性与上限见 `packages/plugin-sdk/src/renderer.ts`
（`PLUGIN_RENDERER_SLOTS`、`PLUGIN_RENDERER_ACTIONS`、`PLUGIN_SLOT_POSITIONS`），
完整示例见 `examples/plugins/ui-slots-lab`。

## 4. 贡献

```ts
type PluginContributes = {
 commands?: PluginCommandContrib[];
 agentTools?: PluginAgentToolContrib[];
 skills?: Array<string | PluginSkillContrib>; // relative paths, or metadata overrides
 agentExtensions?: string[]; // ExtensionAPI modules run in the agent sidecar; needs `agent.extension` (spec 16)
providers?: PluginProviderContrib[]; // Host-owned provider rows; needs `provider.register`; OAuth also needs `provider.oauth` (spec 13)
 settings?: PluginSettingContrib[];
 themes?: PluginThemeContrib[];
 scenicThemes?: PluginScenicThemesContrib;
 windowAppearance?: PluginWindowAppearanceContrib; // native window background and Windows corner request; needs `ui.window.appearance`
 composerTransforms?: PluginComposerTransformContrib[]; // explicit Composer text actions; needs `composer.transform`
 mcpServers?: PluginMcpServerContrib[];
  services?: PluginServiceContrib[];
  bus?: PluginBusContrib;
  views?: PluginViewContrib[];
  sessionSources?: PluginSessionSourceContrib[];
  globalShortcuts?: PluginGlobalShortcutContrib[]; // needs `keyboard.globalShortcut`
};

type PluginCommandContrib = {
 id: string; // plugin-local or fully-qualified
 title: string;
 keywords?: string[];
 category?: string;
};

type PluginAgentToolContrib = {
 name: string; // tool name exposed to agent
 description: string;
 risk?: "low" | "medium" | "high";
 schema?: unknown; // JSON schema object
 planSafeActions?: readonly string[]; // read-only action names for Plan/Goal
};

type PluginComposerTransformContrib = {
 id: string; // plugin-local; [A-Za-z][A-Za-z0-9_-]{0,63}
 title: string | { en: string; "zh-CN": string };
 undoTitle?: string | { en: string; "zh-CN": string };
};

type PluginSettingContrib = {
 key: string;
 title: string; // author language; the generated sheet does not localize
 description?: string;
 type: "string" | "number" | "boolean" | "select" | "json" | "shortcut";
 default?: unknown;
 enum?: Array<{ label: string; value: string | number | boolean }>;
 /** Required for shortcut settings; invokes a declared plugin command. */
 command?: string;
 /** App-local setting scope; OS-global shortcuts use globalShortcuts instead. */
 scope?: "plugin";
 secret?: boolean;
};

type PluginViewContrib = {
 id: string; // ^[a-zA-Z][a-zA-Z0-9_-]{0,63}$, unique within the plugin
 title: string | { en: string; "zh-CN": string };
 icon?: string; // token from the host icon set; unknown tokens draw a letter tile
 entry: string; // relative path to the view's HTML entry
  order?: number; // ascending sort key in the plugin-views menu group, default 0
};

type PluginSessionSourceContrib = {
  id: string; // ^[a-zA-Z][a-zA-Z0-9._-]{0,63}$, unique within the plugin
  label?: string | { en: string; "zh-CN": string };
};

/** One system-wide accelerator a plugin declares (`keyboard.globalShortcut`). */
type PluginGlobalShortcutContrib = {
 id: string; // ^[a-zA-Z][a-zA-Z0-9._-]{0,63}$, unique within the plugin
 command: string; // must be declared in contributes.commands
 default?: string; // accelerator the host registers after load; omitted means `pi.keyboard` registers it later
};

type PluginThemeContrib = {
 id: string; // ^[a-zA-Z][a-zA-Z0-9_-]{0,63}$
 label: string;
 path: string; // relative `.css` file
 base?: "light" | "dark"; // palette the overrides layer on, default `dark`
 assets?: string[]; // package-relative or absolute png/jpg/jpeg/webp/avif/svg/woff2, 4 MB summed;
                    // relative paths resolve inside plugin root; traversal/node_modules are rejected;
                    // each matching `url()` is rewritten to `plugin-asset://`
 variables?: PluginThemeVariableContrib[]; // typed values for `pi.themes.setVariables` (see Appearance extensions)
};

type PluginScenicThemesContrib = {
 id: string;
 label: { en: string; "zh-CN": string };
 description: { en: string; "zh-CN": string };
 keywords?: Array<{ en: string; "zh-CN": string }>;
 icon: "palette";
 themes: Array<{
   themeId: string;
   label: { en: string; "zh-CN": string };
   description: { en: string; "zh-CN": string };
   previewAsset: string;
 }>;
};

type PluginWindowAppearanceContrib = {
 backgroundColor?: { light?: string; dark?: string }; // #rrggbb | #rrggbbaa
 cornerRadius?: number; // integer 0..24 DIP, Windows main window only; default 12
};

`cornerRadius` belongs to the contributing plugin and applies while any of its
declared themes is selected. It does not change macOS/Linux native corners.
Removing the theme or its `ui.window.appearance` grant restores the Windows
main-window default of 12 DIP (`--radius-md`). Invalid or fractional values
reject the manifest. On Windows build 22000 and later, 0 requests square
corners and every positive value requests the same native DWM rounded
preference; Windows chooses the exact radius. Earlier Windows builds retain the
requested DIP radius. On Windows 11, an 8-digit background is composited over
the resolved built-in theme color so the top-level window remains opaque.

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
 // remote HTTP transport
 url?: string; // absolute http(s) endpoint; HTTP may target a trusted LAN host
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
 id: string; // ^[a-zA-Z][a-zA-Z0-9_-]{0,63}$, unique within the plugin
 name: string; // display name in the native provider list
 category?: string | { en: string; "zh-CN": string }; // Add Service group; defaults to plugin name
 description?: string | { en: string; "zh-CN": string }; // Add Service hover/focus introduction, ≤280 chars
 vendorKey?: string; // models.dev vendor key, default `custom`
 baseUrl?: string; // absolute http(s) URL
 apiStyle?: PluginProviderApiStyle; // wire style, default `chat_completions`
 authKind?: "api_key" | "none" | "oauth"; // default `api_key`
 oauth?: { loginLabel?: string; isSubscription?: boolean }; // only with `authKind: "oauth"`
 models: PluginProviderModelContrib[]; // 1..64 entries
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
 id: string; // 1..256 characters, unique within the provider
 name?: string; // display label for the model binding
 contextWindow?: number;
 maxTokens?: number;
 supportsImages?: boolean;
 /** Canonical thinking levels offered by this model, in declaration order. */
 thinkingLevels?: string[];
 /** New sessions use this level when it is present in `thinkingLevels`. */
 defaultThinkingLevel?: string;
};
```
`thinkingLevels` 可选。宿主会裁剪条目、丢弃未知规范档位、去重，并保留剩余的声明顺序。
缺失或不可用的列表会变成空绑定。只有当 `defaultThinkingLevel` 命中该模型列表中的归一化档位
时才会保留；否则会被丢弃，普通绑定归一化会选择第一个可用档位。
清单校验会拒绝非数组的 `thinkingLevels`、其中任何非字符串条目，或非字符串的
`defaultThinkingLevel`；未知的字符串档位则会被接受并在归一化时丢弃。

## 5. 权限枚举

```ts
type PluginPermission =
 | "ui.panel"
 | "ui.view"
 | "ui.theme"
 | "ui.settings"
 | "ui.window.appearance"
 | "clipboard.read"
 | "clipboard.write"
 | "notify"
 | "fs.read"
 | "fs.write"
 | "fs.delete"
 | "agent.tool.register"
 | "agent.prompt.inject"
 | "agent.complete"
 | "agent.extension"
 | "composer.transform"
 | "composer.suggest"
 | "renderer.extension"
 | "provider.register"
 | "provider.oauth"
 | "models.list"
 | "net.fetch"
 | "net.anyHost"
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
 | "session.read"
 | "session.import"
 | "session.read.own"
 | "session.update.own"
 | "session.delete.own"
 | "session.autoTitle"
 | "usage.read"
 | "audio.capture.background"
 | "audio.playback.background"
 | "speech.adapter.register"
 | "keyboard.globalShortcut"
 | "net.websocket";
```

权威列表是 `@pi-desktop/plugin-sdk` 中的 `PLUGIN_PERMISSIONS`。未知权限名在
`pi-plugin check` 中报错（`permission.unknown`）；`validateManifest()` 与宿主安装器
不会拒绝它，但该字符串不匹配任何能力检查，因此不授予任何能力。

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
 root?: "workspace" | "userSelected"; // default `workspace`
 scope?: string[]; // globs relative to the root
 own?: boolean; // delete only: paths this plugin wrote
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
type PluginNetDomains = string[]; // "api.example.com" or "*.example.com"
```

主机掌握的每一条出网路径 —— 面板 session、`pi.net.fetch`、远程 HTTP MCP
端点 —— 都被限定在这些主机名之内。列表缺失、为空或非法就完全不放行出网，
无论 `net.fetch` 怎么声明。条目是裸主机名：没有 scheme、没有端口、没有路径，
也不允许裸 `*`。前缀 `*.` 同时覆盖该域名及其子域名。

`pi.net.websocket` 听同一份列表（`net.websocket`，
[03-plugin-api.md](/zh-CN/spec/07-plugins/03-plugin-api) §3）。该权限已实现：
连接被限定在 `manifest.net.domains` 之内，未被声明的主机会在传输被要求
打开任何东西之前就被拒绝。

### 5.3.1 net.anyHost —— 豁免通道

`"net.anyHost"` 面向端点由用户填写（自建服务器、个人域名等清单无法提前
写明）的插件。持有该权限后，上述所有出网路径都对任意 http(s)/ws(s) 主机
放行 —— 云元数据端点（`169.254.169.254` 等）除外，授权永远到不了那里：
它们的应答是实例凭据。`net.domains` 已声明的主机保持现有行为，存量清单
不受影响；未持有该权限的插件同样零变化。它与其他权限一样在安装/更新
确认页展示，请求时不再有任何弹窗。

## 5.1 总线主题语法

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

`contributes.providers` 声明的 provider 行由宿主写入原生 provider 列表，并归该插件所有
（[ADR 0259](../../../adr/0259-plugin-declared-providers.md)）。每个插件不设 provider 数量上限，
插件包现有的 50 MiB 限制仍是总量边界：

- 声明的 `id` 匹配 `[a-zA-Z][a-zA-Z0-9_-]{0,63}` 且在插件内唯一；行 id 为
  `plugin:<pluginId>:<declaredId>`
- `name` 必填，是设置页显示的名称
- `category` 可选，用作“添加服务”分组；可填写普通字符串或同时提供 `en` 与 `zh-CN`
  的本地化名称，每个名称最多 128 个字符。省略时使用插件名称
- `description` 可选，是“添加服务”中悬停或键盘聚焦时显示的一句话简介；可填写普通字符串
  或同时提供 `en` 与 `zh-CN` 的本地化内容，每条最多 280 个字符
- `baseUrl` 可选，但必须是绝对 `http(s)` URL
- `apiStyle` 可选，默认 `chat_completions`；可取值是 provider 配置中除 `auto`
  以外的风格
- `authKind` 可选，为 `api_key`（默认）、`none` 或 `oauth`
- OAuth provider 需要 `provider.register` 和独立高风险权限 `provider.oauth`，还需要
  绝对 HTTP(S) `baseUrl` 及插件主模块导出的 `onProviderOAuth`；`oauth` 元数据可设置
  `loginLabel` 和 `isSubscription`
- `models` 最多 64 条，id 唯一且长度为 1..256。仅当 provider 使用 API Key 且配置了
  `baseUrl` 时，才允许为空；用户保存 Key 后，宿主会发现并缓存该端点提供的模型

非空的 `contributes.providers` 需要高风险权限 `provider.register`
（[13-plugin-permissions-matrix.md](/zh-CN/spec/07-plugins/13-plugin-permissions-matrix)）。
声明会在每次插件加载时重新读取，并对其自身字段具有权威；禁用插件会保留这些行并
将其关闭，而删除声明或卸载插件会连同已存凭据一起删除该行。

OAuth 登录使用宿主自有的账号界面和加密凭据存储。宿主通过
`pi.providers.oauth.prompt` / `notify` 显示登录提示和进度；OAuth 回调只收到该插件
自身 provider 的凭据。刷新令牌保留在 Electron 主进程与宿主密钥库内，Agent Runtime
只接收请求所需的访问令牌。每个 provider 声明目前只支持一个账号；宿主插件进程不是
操作系统沙箱，因此授予 `provider.oauth` 表示信任该插件处理此 provider 的凭据。
## 6. activationEvents（可选元数据）

`activationEvents` 可描述 `onStartup` 等意图；当前运行时在启动恢复、启用和加载开发目录时直接加载，
没有延迟激活调度器。项目资格由宿主激活范围控制。
`engines.piDesktop` 是作者兼容元数据，不能代替最低版本测试与新增方法检测。
从 `main` 导出生命周期函数，没有 `entrypoints` 清单分发器。

## 7. 验证规则

1. `schemaVersion` 必填且必须是数字。当前格式为 `1`，但不会校验具体取值
2. 需要 `id` / `name` / `version` / `main`
3. 打开 `ui.panel` 需要显式声明和用户授予 `ui.panel`，路径不会隐式授权
4. 如果存在 `agentTools`，则必须声明 `agent.tool.register`。缺少该权限时
   `pi-plugin check` 报错（`permission.tools-missing`），安装器不会拒绝，
   运行时调用 `pi.agent.registerTool` 会因未授权而失败。
   `composerTransforms` 需要 `composer.transform`；每个操作 id 必须匹配
   `[A-Za-z][A-Za-z0-9_-]{0,63}`，并在插件内保持唯一
5. 路径字段不得使用绝对路径或 `..`
6. `main` / `ui.panel` / 技能 / `views[].entry` 路径必须存在
7. 工具 `name` 应只使用 `[a-zA-Z][a-zA-Z0-9_]*`。该规则不做校验：宿主会把其他
   字符替换为 `_` 作为面向智能体的工具名（`plugin_<pluginId>_<name>`），因此仅在
   这些字符上不同的两个名字会冲突
8. 贡献 ID（`themes`、`mcpServers`、`services`、`views`、`composerTransforms`）必须匹配
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
   `provider.register`，OAuth 提供方 → `provider.oauth`，`composerTransforms` →
   `composer.transform`，`agentExtensions` → `agent.extension`，
   `windowAppearance` → `ui.window.appearance`，stdio 服务器 → `mcp.server.local`，
   远程服务器 → `mcp.server.remote`，`services` → `background.service`，
   `bus.publish` → `bus.publish`，`bus.subscribe` → `bus.subscribe`。
   `scenicThemes` 不在校验阶段检查：缺少 `ui.settings` 或 `ui.theme` 时，宿主只是
   不显示该设置入口。
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

19. `renderer` 必须是包内的 `.js` 或 `.mjs` 文件；`rendererActions`（最多 16 条）与
    `rendererCallMethods`（最多 32 条）是非空名字列表，且必须先有 `renderer` 才能声明。
    三者中声明任何一个都需要 `renderer.extension` 权限（§3.2）

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

## 9.1 示例：能力贡献

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
- 宿主应拒绝过高的主要版本；目前 SDK 与宿主都不会把 `schemaVersion` 与 `1`
  比较（§7 第 1 条）
- 未知的可选字段可能会被忽略。未知权限会让 `pi-plugin check` 失败，但安装时不会被
  拒绝（§5）
