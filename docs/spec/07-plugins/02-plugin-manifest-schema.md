# 02. Plugin Manifest Schema

## Appearance extensions

`contributes.themes[].variables` declares typed custom properties that the same
plugin may change at runtime. A declaration has a safe custom-property name and
exactly one type: `length` (`unit: "px"`, numeric `min`, `max`, and `default`),
`number` (finite default and optional range), `color` (hex default), or `select`
(fixed safe `values` and default). Host-reserved prefixes are refused. Values
are not CSS fragments.

`contributes.scenicThemes` declares a data-only host-rendered Settings entry:
a stable `id`, localized label and description, `palette` icon token, localized
keywords, and one to twelve ordered cards. Every card names a same-plugin
theme, localized name/description, and a relative image asset declared by that
theme. It requires both `ui.settings` and `ui.theme`. Plugins provide neither
Settings HTML nor CSS or JavaScript: the host renders the Extensions entry,
cards, range control, and Apply action in its normal React tree.

## 1. Purpose

Freeze the plugin manifest fields to guarantee:

- The host can validate
- Developers can depend on it
- Future versions can migrate

Schema Version: `1`

## 2. Root object

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
 main?: string; // plugin runtime entry
 ui?: PluginUiConfig;
 contributes?: PluginContributes;
 permissions?: PluginPermission[];
 fs?: PluginFsPolicy; // which paths each file permission may touch (§5.2)
 net?: { domains?: string[] }; // egress allowlist (§5.3)
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
  * First-registration default for bundled plugins. Omitted means enabled.
  * Marketplace and development installs still enable after the user grants
  * permissions.
  */
 enabledByDefault?: boolean;
};
```

## 3. UI config

```ts
type PluginUiConfig = {
 panel?: string; // html entry
 width?: number;
 height?: number;
 resizable?: boolean;
 title?: string | {
   en: string;
   "zh-CN": string;
 }; // localized native panel identity; both locales are required for an object
};
```

### 3.1 Localized labels (`i18n`)

`name`, `description`, and `safetyNotes` are display text, so a plugin may
declare them per locale in a top-level `i18n` block. The Extensions page, the
plugin launcher, and the marketplace (which reads the same block from a catalog
entry) show the entry matching the **app language** rather than the author's own
language:

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

Rules:

1. `en` and `zh-CN` are the contract locales. Every Chinese shell locale
   (`zh`, `zh-CN`, `zh-Hans`, `zh-SG`) reads `zh-CN`; every other locale reads
   `en`. A plugin is not required to translate itself into the other shipped
   shell locales, so `zh-TW` reads English rather than half a `zh-CN` guess
   (ADR 0182).
2. Both locales and all three fields are required by the plugin repository's
   validator, but the host is permissive: a missing locale, a missing field, or
   an empty string falls back per field to the other contract locale, and from
   there to the author's flat `name` / `description`.
3. Resolution happens in the host, against the language the desktop shell
   pushes down (`settings.language`, or the OS locale while it is `auto`). The
   stored row keeps the author's strings, so a language change only changes what
   is read and never rewrites the registry.
4. The block is display metadata. A malformed one (not an object of locale →
   object) fails manifest validation; unknown locales and unknown fields inside
   an entry are ignored.
5. The block is identity only (`name`, `description`, `safetyNotes`). Plugin-owned
   copy — panels, views, widgets, generated settings, toasts, runtime command
   titles — is not translated here. The host publishes the active language
   (`pi.app.getLocale`, `appearance:changed`); the plugin localizes itself
   (ADR 0280).

## 4. contributes

```ts
type PluginContributes = {
 commands?: PluginCommandContrib[];
 agentTools?: PluginAgentToolContrib[];
 skills?: Array<string | PluginSkillContrib>; // relative paths, or metadata overrides
 agentExtensions?: string[]; // ExtensionAPI modules run in the agent sidecar; needs `agent.extension` (spec 16)
 providers?: PluginProviderContrib[]; // Host-owned provider rows; needs `provider.register` (spec 13)
 settings?: PluginSettingContrib[];
 themes?: PluginThemeContrib[];
 scenicThemes?: PluginScenicThemesContrib;
 windowAppearance?: PluginWindowAppearanceContrib; // native window background; needs `ui.window.appearance`
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
 title: string; // author language; the generated sheet does not localize
 description?: string;
 type: "string" | "number" | "boolean" | "select" | "json" | "shortcut";
 default?: unknown;
 enum?: Array<{ label: string; value: string | number | boolean }>;
 /** Required for shortcut settings; invokes a declared plugin command. */
 command?: string;
 /** Fixed to plugin for now; global shortcut registration is not supported. */
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
 assets?: string[]; // absolute png/jpg/jpeg/webp/avif/svg/woff2, 4 MB summed;
                    // each matching `url()` is rewritten to `plugin-asset://`
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
 vendorKey?: string; // models.dev vendor key, default `custom`
 baseUrl?: string; // absolute http(s) URL
 apiStyle?: PluginProviderApiStyle; // wire style, default `chat_completions`
 authKind?: "api_key" | "none"; // default `api_key`; `oauth` is refused for now
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
To materialize these fields, the Host trims entries, drops unknown canonical
names, removes duplicates, and preserves the remaining declaration order. An
absent or unusable list becomes an empty binding. `defaultThinkingLevel` is kept
only when it names a normalized level in that model's list; otherwise it is
dropped and normal binding normalization selects the first available level.
Manifest validation rejects a non-array `thinkingLevels`, any non-string entry, or
an explicitly non-string `defaultThinkingLevel`; unknown string names are
accepted and dropped during normalization.

## 5. permissions enum

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
 | "provider.register"
 | "provider.request"
 | "net.fetch"
 | "shell.openExternal"
 | "mcp.server.local"
 | "mcp.server.remote"
 | "background.service"
 | "bus.publish"
 | "bus.subscribe"
 | "browser.cdp"
 | "desktop.control"
 | "models.list"
 | "ui.microphone"
 | "project.create"
 | "session.read"
 | "session.import"
 | "session.read.own"
 | "session.update.own"
 | "session.delete.own"
 | "usage.read"
 | "audio.capture.background"
 | "audio.playback.background"
 | "speech.adapter.register"
 | "keyboard.globalShortcut"
 | "net.websocket";
```

Unknown permission = validation failure.

`fs.read.workspace`, `fs.write.workspace` and `fs.delete.workspace` are the
pre-scope names. They still validate, and the host rewrites them on load to the
minimum safe equivalent (§5.2); new manifests must not use them.

## 5.2 fs — which paths a file permission may touch

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

A permission answers "may this plugin touch files"; this answers "which files".
Globs use `*` for one segment and `**` across separators, matched
case-insensitively against the root-relative path.

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

- An absent `fs` block, an absent mode, or an empty `scope` is valid and means
  **no standing reach**: every access falls to a runtime confirmation, so saying
  nothing grants nothing
- `root: "userSelected"` needs no scope — the directory the user picks through
  `pi.fs.requestDirectory()` is the grant, it lives in memory only, and it dies
  with the plugin process
- `own` is accepted on `delete` only

## 5.3 net — egress allowlist

```ts
type PluginNetDomains = string[]; // "api.example.com" or "*.example.com"
```

Every host-owned outbound path — the panel session, `pi.net.fetch`, and remote
HTTP MCP endpoints — is confined to these hostnames. An omitted, empty, or
malformed list means no egress at all, whatever `net.fetch` says. Entries are
bare hostnames: no scheme, no port, no path, and no bare `*`. A leading `*.`
covers the domain and its subdomains.

`pi.net.websocket` answers to the same list (`net.websocket`,
[03-plugin-api.md](03-plugin-api.md) §3). The permission is implemented: a
connect is confined to `manifest.net.domains`, and a host that is not declared
is refused before the transport is asked to open anything.

## 5.1 Bus topic grammar

Topics are dot-separated segments matching `[a-zA-Z0-9][a-zA-Z0-9_-]*`, at most
8 segments and 128 characters. `contributes.bus.publish` lists concrete topics;
`contributes.bus.subscribe` lists patterns where `*` matches exactly one segment
and `**` matches one or more trailing segments (final segment only).

```json
{
 "bus": {
 "publish": ["build.done"],
 "subscribe": ["build.*", "deploy.**"]
 }
}
```

## 5.4 providers — provider rows the plugin declares

`contributes.providers` declares at most 8 providers that the Host materializes
as rows in the native provider list, owned by the plugin ([ADR 0259](../../adr/0259-plugin-declared-providers.md)):

- the declaration `id` matches `[a-zA-Z][a-zA-Z0-9_-]{0,63}` and is unique
  within the plugin; the row id is `plugin:<pluginId>:<declaredId>`
- `name` is required and is what Settings shows
- `baseUrl` is optional, but must be an absolute `http(s)` URL
- `apiStyle` is optional and defaults to `chat_completions`; the accepted values
  are the provider-config styles except `auto`
- `authKind` is optional, either `api_key` (default) or `none`
- `models` requires 1..64 entries with unique ids of 1..256 characters

`thinkingLevels` is optional. The Host trims entries, drops unknown canonical
names, removes duplicates, and preserves the remaining declaration order. An
absent or unusable list becomes an empty binding. `defaultThinkingLevel` is kept
only when it names a normalized level in that model's list; otherwise it is
dropped and normal binding normalization selects the first available level.

A non-empty `contributes.providers` needs the high-risk `provider.register`
permission ([13-plugin-permissions-matrix.md](13-plugin-permissions-matrix.md)).
The declaration is re-read on every plugin load and is authoritative for its own
fields; disabling the plugin keeps the rows and turns them off, while dropping a
declaration or uninstalling the plugin deletes the row with its stored
credentials.

`oauth` is **not supported yet**: the Host has no plugin OAuth login flow, so an
`oauth` block or `authKind: "oauth"` fails manifest validation. The planned
`provider.oauth` permission and Host-owned login flow are future work, not
available behavior.

## 6. activationEvents (optional)

Examples:

- `onStartup`
- `onCommand:demo.hello.say`
- `onAgentMode`
- `onWorkspaceOpen`

MVP may implement only:
- `onStartup`
- `onCommand:*`

## 7. Validation rules

1. `schemaVersion` must be `1`
2. `id` / `name` / `version` are required
3. Whether a manifest that declares `ui.panel` needs the `ui.panel` permission implicitly (auto-filled) or by explicit declaration is an **open question** (tracked in [08-meta/open-questions.md](../08-meta/open-questions.md))
4. If `agentTools` are present, `agent.tool.register` must be declared
5. Path fields must not use absolute paths or `..`
6. `main` / `ui.panel` / skills / `views[].entry` paths must exist
7. tool `name` allows only `[a-zA-Z][a-zA-Z0-9_]*`
8. Contribution ids (`themes`, `mcpServers`, `services`, `views`) must match
   `[a-zA-Z][a-zA-Z0-9_-]{0,63}` and be unique within their own list;
   `sessionSources` uses the same rule with `.` additionally allowed
9. `themes[].path` must exist and end in `.css`; `themes[].base` may only be
   `light` or `dark`
10. `mcpServers[]` must set exactly one transport's fields: `stdio` requires
   `command` (bare PATH name or plugin-relative, never absolute) and rejects
   `url`/`headers`; `http` requires an absolute `http` or `https` `url` and
   rejects `command`/`args`/`env`. Non-loopback HTTP is unencrypted and must be
   declared in `net.domains`.
11. `bus.publish` entries must be concrete topics and `bus.subscribe` entries
   valid patterns (§5.1)
12. A contribution that needs a permission fails validation when the permission
   is missing: `themes` → `ui.theme`, `views` → `ui.view`, `providers` →
   `provider.register`, stdio servers → `mcp.server.local`, remote
   servers → `mcp.server.remote`, `services` → `background.service`,
   `bus.publish` → `bus.publish`, `bus.subscribe` → `bus.subscribe`.
   `skills` is the exception — it predates the permission gate, so a manifest
   without `agent.prompt.inject` still validates and the runtime simply skips
   the skills
13. Settings keys are unique. `shortcut` settings require `command`, may only
    use the `plugin` scope, and are validated as modifier-plus-key or F-key
    bindings. Secrets are rejected until secure plugin-secret storage exists.
14. `fs.<mode>` requires the matching `fs.<mode>` permission — a scope nobody can
    use is an authoring slip, not a silent no-op. Scope entries must be relative
    (no absolute path, drive letter, or `..`), and `fs.write` / `fs.delete` must
    not use a whole-tree pattern (`**`, `**/*`, `*/**`, `./*`). `own` is accepted
    on `delete` only, and `root` only on `workspace` / `userSelected`
15. `net.domains` entries must be bare hostnames, optionally prefixed `*.`; a
    bare `*` is refused
17. `sessionSources` ids may also contain `.`; labels are optional, localized
    labels must provide both `en` and `zh-CN`, and duplicate ids are rejected
16. `views[].title` is required and, when localized, must carry both `en` and
    `zh-CN`. `views[].icon` is **not** validated against the token list: an
    unknown token degrades to a letter tile, so refusing one would break a
    plugin over a cosmetic detail. The packaging check warns about it instead

18. `contributes.globalShortcuts` allows at most 8 entries and needs
   `keyboard.globalShortcut`. Each `id` matches
   `[a-zA-Z][a-zA-Z0-9._-]{0,63}` and is unique; `command` must be declared in
   `contributes.commands`; `default`, when present, uses the same
   modifier-plus-key / F-key grammar as `shortcut` settings

## 8. Example: minimal plugin

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

## 9. Example: Agent Tool plugin

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

## 9.1 Example: capability contributions

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

`{ "setting": "<key>" }` reads the plugin's own settings; the host environment is
never passed through (D018).

## 10. Compatibility strategy

- A future `schemaVersion: 2` needs a migrator
- The host should reject a too-high major version
- Unknown optional fields may be ignored; unknown required permissions must fail
