# 02. Plugin Manifest Schema

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

## 4. contributes

```ts
type PluginContributes = {
 commands?: PluginCommandContrib[];
 agentTools?: PluginAgentToolContrib[];
 skills?: Array<string | PluginSkillContrib>; // relative paths, or metadata overrides
 settings?: PluginSettingContrib[];
 themes?: PluginThemeContrib[];
 mcpServers?: PluginMcpServerContrib[];
 services?: PluginServiceContrib[];
 bus?: PluginBusContrib;
 views?: PluginViewContrib[];
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

type PluginThemeContrib = {
 id: string; // ^[a-zA-Z][a-zA-Z0-9_-]{0,63}$
 label: string;
 path: string; // relative `.css` file
 base?: "light" | "dark"; // palette the overrides layer on, default `dark`
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
```

## 5. permissions enum

```ts
type PluginPermission =
 | "ui.panel"
 | "ui.view"
 | "ui.theme"
 | "clipboard.read"
 | "clipboard.write"
 | "notify"
 | "fs.read"
 | "fs.write"
 | "fs.delete"
 | "agent.tool.register"
 | "agent.prompt.inject"
 | "net.fetch"
 | "shell.openExternal"
 | "mcp.server.local"
 | "mcp.server.remote"
 | "background.service"
 | "bus.publish"
 | "bus.subscribe";
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
   `[a-zA-Z][a-zA-Z0-9_-]{0,63}` and be unique within their own list
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
   is missing: `themes` → `ui.theme`, `views` → `ui.view`, stdio servers →
   `mcp.server.local`, remote
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
16. `views[].title` is required and, when localized, must carry both `en` and
    `zh-CN`. `views[].icon` is **not** validated against the token list: an
    unknown token degrades to a letter tile, so refusing one would break a
    plugin over a cosmetic detail. The packaging check warns about it instead

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
