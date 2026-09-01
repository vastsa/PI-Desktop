# 13. Plugin Permissions Matrix

## 1. Goals

Provide a permission–capability–risk–default-policy reference table for reuse by UI copy and validation.

## 2. Matrix

| Permission | Risk | Allowed API / capability | Default policy | Notes |
|---|---|---|---|---|
| `ui.panel` | low | Open the plugin panel | Granted at install | Needed by almost all UI plugins |
| `ui.view` | low | `contributes.views` are listed in the work panel and may be opened | Granted at install | Same isolation as a panel window: sandboxed page, per-plugin partition, `net.domains` egress. Filtered by activation scope |
| `ui.theme` | low | `contributes.themes` CSS is loaded and offered in Settings | Granted at install | CSS is sanitized by the host; it cannot script |
| `clipboard.read` | medium | `clipboard.readText`, `clipboard.getHistory` | Confirm on first use | May read sensitive information and retained clipboard history |
| `clipboard.write` | medium | `clipboard.writeText` | Confirm on first use | Prevents clipboard pollution |
| `notify` | low | `ui.notify`, `ui.getNotificationPermission`, `ui.requestNotificationPermission`, `ui.showNativeNotification` | Can be granted by default | Native delivery is OS-controlled; avoid notification-spam abuse |
| `fs.read` | medium | `fs.readText` / `fs.openDefault` / `fs.reveal` / `fs.glob` / `fs.list` / `fs.requestDirectory` | Granted at install, bounded by `manifest.fs.read` | `fs.openDefault` and `fs.reveal` are limited to an explicit file and the same read scope; all file calls remain root- and deny-list-checked |
| `fs.write` | high | `fs.writeText` | Granted at install, bounded by `manifest.fs.write` | Scope is required; a whole-tree pattern fails validation. Out of scope asks the user |
| `fs.delete` | high | `fs.remove` | Granted at install, bounded by `manifest.fs.delete` | Two tiers (`own` / `scope`), always via the OS trash, non-recursive, rate-braked (§2B) |
| `fs.read.workspace` | medium | — | Downgraded on load to `fs.read` with a whole-tree scope | Legacy name; predates scopes |
| `fs.write.workspace` | high | — | Downgraded on load to `fs.write` with **no** scope | Legacy name; every write asks the user until the manifest declares scope |
| `fs.delete.workspace` | high | — | Downgraded on load to `fs.delete` with `own: true` | Legacy name; only the plugin's own output goes without asking |
| `agent.tool.register` | high | Register an agent tool | Confirm at install | Tool execution is audited separately |
| `agent.prompt.inject` | high | Inject a system prompt; activates `contributes.skills` | Deny by default / strong confirmation | Easily leads to behavior hijacking |
| `net.fetch` | high | `net.fetch` | Deny by default | Confined to `manifest.net.domains`; an empty or malformed list means no egress (§2A) |
| `shell.openExternal` | medium | Open external link | Confirm on first use | Prevents phishing links |
| `mcp.server.local` | high | Spawn a `transport: "stdio"` MCP server declared in the manifest | Deny by default | Runs a local executable; its tools reach the agent |
| `mcp.server.remote` | high | Connect a `transport: "http"` MCP server | Deny by default | Sends tool arguments to a third-party endpoint; non-loopback HTTP is unencrypted |
| `background.service` | medium | Start `contributes.services` and keep the plugin process resident | Confirm at install | Supervised with backoff; visible on the Plugins page |
| `bus.publish` | medium | `bus.publish` to declared topics | Confirm at install | Other plugins can act on the message |
| `bus.subscribe` | medium | `bus.subscribe` to declared patterns | Confirm at install | Can observe another plugin's messages |

## 2A. A permission is the switch; the manifest carries the range

Two capabilities are too coarse to be answered by a name alone, so the name says
whether the plugin may act and a manifest field says how far. Both fields are
enforced by the host, shown to the user next to the permissions, and validated at
install time.

| Field | Bounds | Absent or empty means |
|---|---|---|
| `net.domains` | Every host-owned egress path: the panel session, `pi.net.fetch`, remote HTTP MCP endpoints | No egress at all, whatever `net.fetch` says |
| `fs.read` / `fs.write` / `fs.delete` | Which paths that file mode may touch | No standing reach; every access falls to a confirmation |

Failing closed on an absent field is what makes the two safe to omit: a
manifest that says nothing grants nothing. See
[04-plugin-security.md](04-plugin-security.md) §6 and §8.1, and ADR 0088.

The two are also linked. `fs.read` may declare the whole tree because a read
only becomes a leak when the bytes can leave, and `net.domains` closes that
half. `fs.write` and `fs.delete` are dangerous on their own, so a whole-tree
pattern (`**`, `**/*`, `*/**`, `./*`) fails manifest validation for those modes.

## 2B. Deletion

`fs.delete` is the one file mode whose damage is not undoable by re-running the
plugin, so it carries three bounds the other modes do not:

1. **Two tiers.** `own: true` lets a plugin remove files it wrote itself — the
   host keeps a write ledger in the plugin's data directory — with no scope and
   no prompt; a file the user has modified since drops out of the ledger.
   Deleting anything else needs a declared `scope`, and out-of-scope paths ask
   the user.
2. **The OS trash.** Removal goes through `shell.trashItem`, never `rm`, and
   never recursively: a non-empty directory is refused rather than emptied. The
   host keeps no copy of the user's data to provide this.
3. **A rate brake.** 50 deletes per rolling 60s per plugin. Past it the user is
   asked once with the reason given as rate rather than path, because
   `recursive: false` bounds one call and not a `glob` plus a loop.

## 3. Permission dependencies

- `ui.panel` is required to load a panel entry
- `ui.view` is required to contribute work panel views; it is independent of
  `ui.panel`, so a plugin may ship docked views without a detached window
- `agent.tool.register` is required to contribute agentTools
- When `fs.write` is present, it is recommended to also declare `fs.read`
- `manifest.fs.<mode>` requires the matching `fs.<mode>` permission; a scope
  nobody can use fails validation rather than being silently ignored
- `fs.requestDirectory` (the `userSelected` root) is gated on `fs.read`; writing
  or deleting inside the chosen directory still needs `fs.write` / `fs.delete`
- A contribution whose permission is missing fails manifest validation
  (`themes`, `mcpServers`, `services`, `bus`); `skills` is the exception and is
  skipped at load time instead (see
  [02-plugin-manifest-schema.md](02-plugin-manifest-schema.md) §7)

## 3A. Plan operating-state rule

Every `agentTools` contribution is denied in Plan, regardless of this matrix's
risk or default policy. `agent.tool.register` authorizes registration for
Agent, not visibility in Plan. The host returns `PLUGIN_DISABLED_IN_PLAN` for a
direct Plan call and records the denial. Plugin tools become eligible only
after the same Agent is approved into Agent mode.

## 4. Permission display copy

English is the primary copy. The zh-CN column holds the localized example strings.
A file permission is never shown alone: the declared scope is rendered beside it,
so "Modify the files it lists" is followed by the list.

| Permission | English copy | zh-CN example |
|---|---|---|
| `fs.read` | Read the files it lists | 读取它列出的文件 |
| `clipboard.read` | Read the current clipboard and retained history | 读取当前剪贴板和保留的历史 |
| `fs.write` | Modify the files it lists | 修改它列出的文件 |
| `fs.delete` | Delete the files it lists, to the trash | 删除它列出的文件（进回收站） |
| `notify` | Show in-app and native notifications | 显示应用内和系统通知 |
| `agent.tool.register` | Provide executable tools to the AI Agent | 向 AI Agent 提供可执行工具 |
| `agent.prompt.inject` | Adjust agent instructions | 调整智能体指令 |
| `net.fetch` | Access the network | 访问网络 |
| `shell.openExternal` | Open external links | 打开外部链接 |
| `ui.theme` | Provide a theme | 提供主题 |
| `mcp.server.local` | Run a local MCP server | 运行本地 MCP 服务 |
| `mcp.server.remote` | Reach a remote MCP server | 连接远端 MCP 服务 |
| `background.service` | Keep a background service running | 保持后台服务运行 |
| `bus.publish` | Send messages to other plugins | 向其他插件发送消息 |
| `bus.subscribe` | Receive messages from other plugins | 接收其他插件的消息 |

## 5. Adding permissions on upgrade

If new permissions appear on upgrade:

1. Compute the diff
2. Force user confirmation
3. If not confirmed, cancel the upgrade or disable the new capabilities (canceling the upgrade is recommended)

## 6. Runtime check pseudocode

```ts
assertPermission(pluginId, perm) {
 if (!granted(pluginId, perm)) throw ERROR_PERMISSION_DENIED
}
```

Every Host API entry point must assert first. A file entry point then passes
three more gates, in this order — a later gate can only refuse, never widen:

```ts
assertFsAccess(pluginId, mode, requestedPath) {
 assertPermission(pluginId, `fs.${mode}`)              // declared AND granted
 full = realpathWithinRoot(root(pluginId, mode), requestedPath)
 if (!full) throw NOT_FOUND | INVALID_ARGUMENT         // symlinks resolved first
 if (isDenied(full) || isHostReserved(full)) throw ERROR_PERMISSION_DENIED
 if (!inScope(full, declaredScope(pluginId, mode))) await confirmWithUser(...)
}
```

## 7. Acceptance

1. Unauthorized API calls fail
2. Permission copy is visible in the install UI, and a file permission shows its
   declared scope alongside
3. Upgrades that add permissions prompt the user
4. A write or delete outside the declared scope prompts, and a denial is audited
   as `PERMISSION_DENIED`
5. `.env` and `.git/**` stay unreadable under a whole-tree read scope, and do not
   appear in `fs.glob` results either
6. A symlink inside the root pointing outside it does not carry an access out
7. A delete lands in the OS trash, refuses a non-empty directory, and is
   interrupted past 50 removals in a rolling minute
8. A plugin declaring only the legacy `fs.*.workspace` names loses write and
   delete reach, and the Plugins page says so
