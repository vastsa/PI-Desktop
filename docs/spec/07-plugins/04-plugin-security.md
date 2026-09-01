# 04. Plugin Security

## 1. Threat model

Plugins may come from:
- The user's own development
- Shared by colleagues
- Third parties in a future marketplace

Main risks:
1. Malicious file read/write
2. Malicious command execution
3. Stealing API keys / session content
4. Hijacking agent tools
5. Phishing via the UI

## 2. Default-deny principle

- Undeclared permission = unavailable
- Disabled plugin = code not loaded
- Unconfirmed high-risk action = not executed
- Host API not on the allowlist = does not exist

## 3. Isolation strategy

### Must
1. Plugin UI is isolated from the host UI DOM
2. Plugins cannot directly require host modules
3. The secret store is not open to plugins
4. The plugin-private data directory is separate from the host core library

Clipboard history is host-owned and remains in the Electron main process only.
It is never written to the plugin data directory or the host database. A plugin
can read it only through `clipboard.read`, which is also the permission used by
`readText`; every `getHistory` call is audited with its returned entry count.
The bounded in-memory retention limits the privacy exposure to the current app
run and is cleared on exit.

### Goals
1. Plugin main runs in a separate process
2. Crash isolation
3. Resource limits (later: CPU/memory/timeout)

## 3.1 Contributed theme CSS

A theme contribution (`ui.theme`) is the one case where plugin-authored content
runs inside the host renderer, so it crosses a sanitizer in the main process
before it is ever sent to the UI:

- Rejected: `@import`, any `url()` target that is not a `data:` URI, a `url(`
  the parser cannot resolve, `javascript:`, `expression(`, and markup sequences
  (`<style`, `</style`, `<!--`); an empty sheet is refused too
- Capped at 256KB per file, 8 themes per plugin
- The CSS is read from disk at load time and delivered whole over IPC; the
  renderer injects it into a single dedicated `<style>` element appended after
  the app's own stylesheets, so it can override tokens but never inject markup
- Selecting a theme is a settings value (`plugin:<pluginId>:<themeId>`); if the
  providing plugin is disabled or uninstalled the setting falls back to `system`

CSS cannot script, but it can mislead: a theme is still third-party code shaping
what the user sees, which is why it is a declared, revocable permission.

## 4. Permission-grant UX

At install/load time, show:

- Permission list
- Risk description
- Developer info
- Source path

User actions:
- Accept and enable
- Cancel

First use of a high-risk API may re-confirm.

## 5. Data isolation

Plugins can access:
- Their own settings
- Their own data path

Plugins cannot access:
- Other plugins' data
- Host secrets
- The host's full session database (unless a controlled API exists in the future)

## 5.1 Inter-plugin message bus

The bus is the only channel between two plugins, and it is deliberately narrow:

- Both sides declare their traffic in the manifest — `bus.publish` lists concrete
  topics, `bus.subscribe` lists patterns — and the broker refuses anything
  undeclared even when the permission is granted
- Routing lives entirely in the host; a subscriber never learns who else
  subscribes, and a publisher is excluded from its own fan-out
- A message carries only `topic`, `from`, `payload`, and a host-assigned `at`
- Caps: 64KB per payload, 16 subscriptions per plugin, 100 publishes per rolling
  10s window; over-cap calls fail with `LIMIT_EXCEEDED` / `RATE_LIMITED` and are
  audited alongside the topic
- A payload is data, not capability: receiving a message grants nothing the
  subscriber did not already have

Treat a topic as public within the app: any plugin that can declare a matching
pattern and hold `bus.subscribe` will see it. Do not put secrets on the bus.

## 6. Path safety

`fs.read` / `fs.write` / `fs.delete` say whether a plugin may touch files;
`manifest.fs` says which ones (see
[02-plugin-manifest-schema.md](02-plugin-manifest-schema.md) §5.2 and ADR 0088).
Every `pi.fs.*` call passes four gates in a fixed order, and a later gate can
only refuse:

1. **Permission** — declared *and* granted. The runtime uses the intersection, so
   a permission the user revoked stops working even though the manifest still
   asks for it
2. **Containment** — `realpath` on both the root and the target, so a symlink
   inside the workspace pointing at `~/.ssh` fails here rather than passing a
   string comparison. A path being created resolves through its nearest existing
   ancestor, so a new file is not indistinguishable from an escape. Absolute
   paths and `..` are refused; a path that merely does not exist is reported
   `NOT_FOUND`, not as an escape
3. **Deny-list**, which overrides every root, scope, and grant:
   - credentials: `.env*`, `.npmrc`, `.netrc`, `.pypirc`, `.git-credentials`,
     `id_rsa*` and friends, `*.pem`, `*.p12`, `*.pfx`, `*.keystore`
   - directories, at any depth: `.git`, `.ssh`, `.aws`, `.gnupg`, `.kube`,
     `.docker`
   - the host's own data directory, which holds provider keys and the session
     store
   - the root itself, for a delete
4. **Declared scope**, else a native confirmation (§6.2)

`pi.fs.glob` answers to the same rules — a name is a read, so denied paths and
reserved trees are omitted from the results, matches are filtered by the read
scope, and `node_modules` / `.git` / `.venv` / `__pycache__` are never walked.

### 6.1 Deletion

Deletion is the only file operation the user cannot recover by re-running the
plugin, so it is bounded four ways:

- **Two tiers.** With `own: true` the host keeps a write ledger (path plus mtime)
  in the plugin's data directory and lets the plugin remove what it wrote itself,
  no scope and no prompt. If the file's mtime has moved past the recorded one,
  the user has edited it since and it is no longer the plugin's. Deleting
  anything else needs a declared `scope`.
- **The OS trash.** Removal goes through `shell.trashItem`, never `rm`, so a gate
  that got it wrong costs the user a restore rather than the file. The host
  copies none of the user's data to provide this.
- **Never recursive.** A non-empty directory is refused rather than emptied.
- **A rate brake.** 50 removals per rolling 60s per plugin, because
  `recursive: false` bounds one call and not a `glob` followed by a loop. Past
  the brake the user is asked once, with the reason given as rate rather than
  path.

### 6.2 Runtime consent

An access the manifest does not cover reaches a native `dialog.showMessageBox`:
**Deny** / **Allow once** / **Allow this session**. A session grant covers the
containing directory, is held in memory, and dies with the process; nothing is
persisted, and a rate-brake prompt is offered no session option at all. A host
with no consent service refuses — a host that cannot ask must never assume yes.
Both the denial and the grant are audited.

### 6.3 The user-selected root

`pi.fs.requestDirectory()` opens the native directory picker; inside the returned
directory the plugin needs no manifest scope, because the user just pointed at
it. Containment and the deny-list still apply there. The handle is memory-only
and dies with the process, so the plugin holds unlimited reach and zero standing
power — the model the browser's File System Access API uses.

## 7. Agent security

- Plugin tool names are namespaced to avoid collisions using the frozen forced prefix `plugin_<pluginIdSafe>_<toolName>` (D015)
- tool execution timeout
- tools can be disabled by the user in one click
- the prompt-injection API is high-risk by default and requires an explicit permission

## 7.1 Skills and MCP tools reaching the agent

Both surfaces let a plugin change what the agent knows or can do, so both are
bounded before they reach the model:

**Skills** (`agent.prompt.inject`) — the system prompt carries only the catalog
(id, name, one-line description, capped at 240 chars); a body is read on demand
through the built-in `Skill` tool. A plugin may teach at most 32 skills, each
document at most 128KB. Without the permission the skills are simply skipped:
the manifest still validates, nothing reaches the prompt.

**MCP tools** (`mcp.server.local` / `mcp.server.remote`) — discovered tools are
registered under the same `plugin_*` namespace as hand-written plugin tools and
therefore inherit the tool timeout, the audit trail, and the per-plugin disable
switch. They are always registered at `risk: "medium"`: their schema and
description come from a third-party server, so the host cannot trust a
self-declared risk level. At most 64 tools per server and 8 servers per plugin.

Plan is an additional host policy boundary for agent tools:

- no plugin tool is visible or executable in Plan;
- the deny precedes manifest risk, declared/granted permissions, session
  grants, and the `auto` permission mode;
- a direct forged `tools.execute` call returns `PLUGIN_DISABLED_IN_PLAN` and is
  audited; it is not forwarded to the plugin runtime;
- plugin commands and panels may remain usable as explicit user UI actions,
  but they cannot become model-callable Plan tools or silently mutate Plan
  state.

## 8. Network and external links

- `net.fetch` is not granted by default
- `openExternal` should confirm. `fs.openDefault` and `fs.reveal` are separate:
  each accepts only an existing root-relative file that already passes the
  plugin's `fs.read` policy. They are intended for explicit file-view actions,
  not arbitrary URL or absolute-path opening; `fs.reveal` only asks the OS file
  manager to select the file.
- Plugins are forbidden from silently downloading and executing binaries (not done at all in MVP)

### 8.0 Egress allowlist

A permission cannot express "read broadly but leak nothing", so the range lives
in the manifest: `net.domains` is a single per-plugin hostname allowlist and every
outbound path the host owns answers to it.

- **Panel sessions.** `sandbox: true` removes Node, not the network, so a panel
  was previously a full browser that never consulted `net.fetch`. The session now
  runs a `webRequest` filter, refuses every device permission, and denies
  `window.open`, which would otherwise mint a window outside the filtered session
- **`pi.net.fetch`.** Checks the allowlist and follows redirects by hand, because
  an allowed host that 30x-es to an undeclared one would carry the request out
- **Remote MCP endpoints.** Answer to the same list, not to their permission alone.
  HTTP endpoints may be on a trusted LAN, but plain HTTP is unencrypted and is
  called out during configuration or plugin permission review. The MCP client
  follows redirects manually, allows at most five HTTP(S) hops, and re-checks
  the allowlist before every hop.

An absent, empty, or malformed list means no egress at all, and a bare `*` is
refused at install so nobody declares their way out. This is what makes a
generous `fs.read` scope affordable (§6).

Still open, tracked separately: `agent.prompt.inject` (skill text can ask a
shell-capable agent to do the carrying), `shell.openExternal`, a `bus.publish`
relayed to a net-capable plugin, and raw `fetch` inside the plugin process — the
last one needs the sandboxed plugin runtime from ADR 0008 D009.

## 8.1 MCP server egress and credentials

An MCP server is a second egress path next to `net.fetch`, so it is declarative
and reviewable rather than programmatic — a plugin cannot open a connection the
manifest did not name:

- `transport: "stdio"` spawns a local executable (`mcp.server.local`). The
  `command` must be a bare PATH name or a plugin-relative path; absolute paths
  are refused at validation time. The child gets a minimal environment — only
  the declared `env` entries plus what the host needs to run a process.
- `transport: "http"` reaches a remote endpoint (`mcp.server.remote`). The `url`
  may use `http` or `https`; non-loopback HTTP is unencrypted and should only be
  used on a trusted network. Plugin endpoints must also be covered by
  `manifest.net.domains`. Tool arguments leave the machine, which is why the
  permission copy says so plainly.
- `env` and `headers` values resolve **only** from the plugin's own settings via
  `{ "setting": "<key>" }`. The host environment is never passed through, and a
  literal secret in the manifest is a review smell, not a supported pattern
  (D018).
- Connection budget: 10s to complete `initialize`, 100s per `tools/call`, 8
  `tools/list` pages, 4MB per stdio line. Servers are connected lazily and torn
  down when the plugin unloads or is disabled.

## 9. Auditing and emergency response

Users should be able to:
- View plugin permissions
- View plugin error logs
- Disable in one click
- Uninstall in one click

The host should be able to:
- Auto-disable a plugin on anomaly
- Guarantee the main app can start

## 10. Security acceptance

1. Writing a file fails without the `fs.write` permission, and a write outside
   `manifest.fs.write.scope` prompts the user
2. Deleting a file fails without the `fs.delete` permission, never recurses, lands
   in the OS trash, and is interrupted past 50 removals in a rolling minute
3. After disabling a plugin, its tools are no longer visible
4. A plugin cannot read API keys
5. A plugin panel cannot call arbitrary host IPC
6. An uncaught exception from a plugin does not cause the app to exit
7. A theme CSS file with `@import` or a remote `url()` is refused, and disabling
   the providing plugin drops the app back to the `system` theme
8. Publishing to an undeclared topic fails, and a publisher never receives its
   own message
9. An MCP server declared with an absolute `command` fails manifest validation;
   a non-loopback plain-HTTP URL is accepted only when its host is declared in
   `manifest.net.domains` and the UI shows the unencrypted-connection warning
10. A low-risk or granted plugin tool still fails closed in Plan


## 11. Implementation status

Current enforcement:

1. Default-deny permission checks in `PluginRuntime`, over the intersection of
   declared and granted, so a revoked permission actually stops working
2. Symlink-safe containment plus an unconditional deny-list for plugin fs APIs,
   with the reach of each file mode bounded by `manifest.fs` and anything outside
   it falling to a native confirmation (§6)
3. Panel windows use sandboxed preload + isolated session partitions. Their
   custom cross-platform titlebar is preload-owned, keeps its controls in a
   closed Shadow DOM, and routes only a fixed sender-validated window-action
   tuple without adding window primitives to `window.pluginBridge`
4. Secrets / host DB remain inaccessible to plugins
5. Marketplace/package install requires explicit permission acceptance in UI
6. Auto-update refuses silent permission expansion
7. Plugin main runs in a dedicated `utilityProcess` per plugin (ADR 0008) with a
   minimal environment; all `pi.*` calls cross an allowlist + permission gateway
   in the host, and a plugin crash only tears down that plugin
8. Contributed theme CSS is sanitized in the main process before it reaches the
   renderer (§3.1)
9. Bus routing is host-owned with declared topics and hard caps (§5.1)
10. MCP servers are declared, permission-gated, and fed credentials only from
    plugin settings (§8.1)
11. Egress is confined to `manifest.net.domains` at every chokepoint the host
    owns (§8.0)
12. Plugin deletions go to the OS trash, are non-recursive, and are rate-braked
    (§6.1)

Not enforced yet:

- Capability sandboxing inside the plugin process (Node built-ins are reachable
  there, so `fs.*` permissions gate the plugin API, not the process). This is the
  remaining gap that matters: everything in §6 and §8.0 bounds a plugin using the
  API it is supposed to use, not one that bypasses it (ADR 0008 D009)
- CPU / memory limits
- Signature verification (packages are only sha256-checked)
- Declared manifest permissions are auto-granted at load time, subject to the
  user unchecking them at install
- A `userSelected` root does not survive a restart, so a plugin has to ask again
  each session
