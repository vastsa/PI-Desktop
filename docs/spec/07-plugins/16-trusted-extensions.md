# 16. Trusted Extensions

> Status: Implemented v1.1 (D387 / D388, ADR 0214 / ADR 0215); implementation notes are marked "v1 note"
> Scope: v1.1. v2 and v3 items are listed in §12 and are not committed.

## 1. Purpose and terminology

Plugins ([01-plugin-system.md](01-plugin-system.md)) are the one extension
surface of PI-Desktop. This document specifies one plugin contribution,
`contributes.agentExtensions`: TypeScript or JavaScript modules that run
inside the Agent sidecar, receive an `ExtensionAPI` object, and register
tools, commands, and event handlers directly on the agent loop. The
`ExtensionAPI` contract is the one defined by `@earendil-works/pi-coding-agent`,
which PI-Desktop adopts alongside the `pi-ai` and `pi-agent-core` kernel
(ADR 0002), so an extension written for the pi CLI is the module a plugin
contributes. D388 folded the earlier standalone "trusted extensions"
registry into this contribution; the engine below is unchanged.

| Term | Meaning |
|---|---|
| Agent extension | One module a plugin lists in `contributes.agentExtensions`, written against `ExtensionAPI`, running with the trust level of the Agent sidecar |
| Plugin | A PI-Desktop plugin with a manifest, running in its own process under the permission gateway (ADR 0008); the owner, installer, and enablement record of its agent extensions |
| Adapter | The layer in `packages/agent-runtime` that implements `ExtensionAPI` on top of the desktop runtime |
| Runner | One desktop-owned `TrustedExtensionRunner` instance bound to one desktop session (v1 note: the pi-coding-agent `ExtensionRunner` is not reused because it binds the terminal theme; its `ExtensionAPI` types are a types-only dependency) |

## 2. Positioning and trust model

1. Agent extensions are installed, enabled, scoped, updated, and removed as
   part of their plugin. There is no second list, store, or settings page.
2. An agent extension is trusted code. It executes inside the Agent sidecar,
   which already holds the bash, edit, and write tools, so granting the
   `agent.extension` permission grants exactly what running the agent already
   grants. The plugin sandbox in [04-plugin-security.md](04-plugin-security.md)
   does not cover these modules, which is why the permission is a separate,
   high-risk grant rather than an implicit part of `agent.tool.register`.
3. Nothing runs without the grant. A plugin that declares
   `contributes.agentExtensions` without `agent.extension` fails manifest
   validation; a plugin whose recorded grants omit the permission loads with
   its modules skipped and audited (`plugin.agentExtensions.skipped`). D007
   stays in force: PI-Desktop never auto-imports `~/.pi`.
4. Project scope is the plugin's activation scope. A plugin limited to some
   projects contributes its modules only to sessions in those projects. v1
   note: there is no separate project trust state, so the plugin scope is the
   trust decision and `project_trust` is not emitted.
5. Marketplace distribution of plugins holding `agent.extension` is not
   enabled in v1.1: the permission is accepted from local imports and
   development plugins. Marketplace listing waits for signing (spec 08).

## 3. Contribution and import

### 3.1 Manifest

```json
{
  "id": "acme.git-helper",
  "name": "Git helper",
  "version": "1.0.0",
  "main": "main.js",
  "permissions": ["agent.extension"],
  "contributes": { "agentExtensions": ["src/index.ts"] }
}
```

Rules: at most eight entries; each is a relative `.ts`, `.mts`, `.js`, or
`.mjs` path inside the plugin directory; the file must exist at load; a
manifest that lists entries without the permission is invalid
([02-plugin-manifest-schema.md](02-plugin-manifest-schema.md) §4 and §7).
`main` may be a no-op module when the plugin contributes nothing else.

### 3.2 Importing a pi CLI extension

Plugins → "Import pi extension" opens a native picker (main owns the path,
D344) for a file or a directory. Main resolves entries with the
`pi-coding-agent` loader rules (a `package.json` `pi.extensions` field, else
`index.ts` / `index.js`, else loose `*.ts` / `*.js` files one level deep),
copies the source under `<dataDir>/plugins/imported/<slug>/src/`, writes the
manifest above with id `imported.<slug>`, and registers the directory as a
development plugin through the same path as "Load local plugin". A directory
that ships a `package.json` also has it (plus its lockfile) copied to the
plugin root with any `workspaces` field stripped; if it declares
`dependencies`, main installs them into the plugin root before the first load
with `npm install --omit=dev --legacy-peer-deps --no-audit --no-fund
--ignore-scripts` (bounded time, no third-party install script ever runs,
kernel packages keep resolving through virtual modules). A failed install is
reported to the renderer and never blocks the import — the extension then
reports its own load error. The confirm before the picker discloses the npm
step and is the trust decision; the row then shows the `agent.extension`
permission like any other grant.

| Source | Becomes |
|---|---|
| A pi extension directory or file | A development plugin under `plugins/imported`, id `imported.<slug>` |
| A plugin package declaring `contributes.agentExtensions` | Installed like any plugin; the grant is asked for at install |
| A `package.json` with a `pi.extensions` field | The listed entries, relative to `src/` |

## 4. Loading and runtime

### 4.1 Where extensions run

Extensions load inside the Agent sidecar process (`packages/agent-runtime`),
never in Electron main, the renderer, or a plugin host process.

### 4.2 Loader

- The sidecar pins `@earendil-works/pi-coding-agent` at exactly the version
  pinned for `pi-ai` and `pi-agent-core`, as a types-only dependency. The
  three versions must match; CI fails when they drift.
- The loader mirrors the `pi-coding-agent` discovery rules and uses
  `jiti/static` with `virtualModules`, so the babel transform is bundled
  and no path resolution happens at runtime. The bundling step is verified
  by a contract test that runs the bundle outside the repository (E2E-245).
- Import aliases: `pi-ai`, `pi-agent-core`, and `typebox` resolve to the
  sidecar's copies; `@earendil-works/pi-coding-agent` resolves to a runtime
  shim that exports `defineTool` and the tool-result type guards. `@earendil-works/pi-tui`
  resolves to a stub module that exports every symbol as an inert
  value so a top-level import never fails. Using a stubbed symbol raises a
  diagnostic at call time.

### 4.3 Runner per session

- Each desktop session gets its own Runner. The Runner is created with the
  session's runtime and disposed when the session's runtime is discarded.
- Module instances are shared across Runners because jiti caches modules.
  Module-level state is therefore shared between sessions, matching what an
  extension author sees when pi runs several sessions in one process. This
  is documented, not worked around, in v1.
- Enabling, disabling, or rescanning invalidates every Runner; affected
  sessions reload extensions at the next turn boundary. A running turn is
  never interrupted by a reload.

### 4.4 Load failures

A load error never fails the session. The extension is marked `error` with
the message and stack in diagnostics, the remaining extensions load, and the
turn proceeds. The composer shows a one-line notice when an enabled
extension failed to load for the active session.

## 5. API support matrix (v1)

Every `ExtensionAPI` member falls into exactly one class. Unsupported members
exist on the object, do nothing, return the documented neutral value, and
emit one diagnostic per extension per member. They never throw, so an
extension that only uses supported members works even if it also touches
unsupported ones.

| Class | Members |
|---|---|
| Supported | `registerTool`, `registerCommand`, `on(...)` for every event in §6, `exec`, `getActiveTools`, `getAllTools`, `setActiveTools`, `getCommands`, `setModel` (v1 note: returns `false`, the desktop owns the session's provider binding), `getThinkingLevel`, `setThinkingLevel`, `setSessionName`, `getSessionName`, `sendUserMessage` (Host-owned queue, D386), `getFlag` |
| Supported on context | `ui.notify`, `ui.confirm`, `ui.select`, `ui.input`, `ui.setStatus`, `ui.setWorkingMessage`, `cwd`, `modelRegistry`, `isIdle`, `abort`, `hasPendingMessages`, `getContextUsage`, `compact`, `getSystemPrompt`, `waitForIdle`, `newSession`, `fork` |
| Deferred to v2 | `sendMessage`, `appendEntry`, `setLabel`, `sessionManager` read API, `switchSession`, `registerShortcut`, `registerMarkdownTransformer`, `ui.setEditorText`, `ui.getEditorText`, `ui.addAutocompleteProvider`, `registerFlag` value editing |
| Unsupported | `ui.setWidget`, `ui.setFooter`, `ui.setHeader`, `ui.setTitle`, `ui.custom`, `ui.overlay`, `ui.onTerminalInput`, `ui.setWorkingVisible`, `ui.setWorkingIndicator`, `ui.setHiddenThinkingLabel`, `ui.pasteToEditor`, `ui.editor`, `registerMessageRenderer`, `registerEntryRenderer`, `navigateTree`, `shutdown` |

Neutral values: `getFlag` returns the declared default; `registerFlag` records
the declaration so `getFlag` works but exposes no CLI or UI in v1;
`sessionManager` accessors return empty results; UI setters return a no-op
`dispose`.

## 6. Event mapping

Events fire from the desktop runtime's existing hook points. Handler results
are honored where the event type defines a result.

| Event | Desktop hook point | Result honored |
|---|---|---|
| `session_start`, `session_shutdown` | Runner creation and disposal | No |
| `session_info_changed` | Session rename through `setSessionName` | No |
| `project_trust` | v1 note: not emitted; enablement per project is the trust decision | No |
| `resources_discover` | v1 note: not emitted; skills and prompt discovery stay in Electron main | n/a |
| `before_agent_start` | Before the first provider request of a turn | Yes, system prompt and message edits |
| `context` | `prepareNextTurn` | Yes, replacement message list |
| `before_provider_request`, `before_provider_headers`, `after_provider_response` | Provider call wrapper | Yes for request and headers |
| `agent_start`, `agent_end`, `agent_settled` | Agent loop boundaries | No |
| `turn_start`, `turn_end` | Turn boundaries | No |
| `message_start`, `message_update`, `message_end` | Agent message events | v1 note: no, pi-agent-core offers no post-hoc replacement |
| `tool_call` | `beforeToolCall` | Yes, block with reason |
| `tool_execution_start`, `tool_execution_update`, `tool_execution_end` | Tool execution stream | No |
| `tool_result` | `afterToolCall` | Yes, replacement result |
| `model_select`, `thinking_level_select` | v1 note: not emitted; a binding change retires the runtime | No |
| `session_before_compact`, `session_compact`, `session_compact_failed` | Compaction pipeline | Yes for `session_before_compact` |
| `session_before_fork` | v1 note: not emitted; fork runs in Electron main | n/a |
| `input` | v1 note: not emitted; Host queue admission is not wired yet | n/a |
| `user_bash`, `session_before_switch`, `session_before_tree`, `session_tree`, `ui_prompt_start`, `ui_prompt_end` | Not emitted in v1 | n/a |

A handler that throws is logged as a diagnostic and treated as returning
`undefined`. A handler that exceeds 30 s for a result-bearing event is
abandoned with a diagnostic and the turn proceeds with the unmodified value.

## 7. Tools

1. A registered tool joins the session's tool catalog under its declared
   name. A name that collides with a core tool, a plugin tool, or a user MCP
   tool is rejected with a diagnostic; the earlier registration wins.
2. Extension tools are non-core: they follow the same mode gating and
   ToolSearch deferral as plugin tools. They are available in Agent mode and
   follow the existing per-mode allowlist elsewhere.
3. Execution happens in the sidecar with the `ExtensionAPI` `execute` signature.
   No host permission prompt is raised; the trust decision was made at
   enablement. `onUpdate` streams map to tool execution update events.
4. Every execution writes an audit line with extension id, tool name, and
   duration. Parameters are not logged.
5. `exec` runs in the sidecar with the session's working directory and the
   session's proxy and environment settings.

## 8. Commands

1. `registerCommand` entries appear in the Commands section of global search
   (see [09-plugin-command-palette.md](09-plugin-command-palette.md)) as
   `/<name>` with the extension's label as the source, after built-in and
   plugin commands.
2. A command runs in the sidecar with the extension command context bound to
   the active session. It requires an active session whose runtime has
   loaded extensions in this app run; otherwise the composer reports that a
   chat must be started first.
3. Commands typed in the composer as `/<name>` resolve in this order:
   built-in, prompt template, plugin, extension. Collisions are diagnostics.
4. A running command blocks composer submission the same way a plugin command
   does and can be cancelled from the status line.

## 9. UI bridge

Interactive context calls travel sidecar → Electron main → renderer and back.

| Call | Renderer surface | Timeout | On abort |
|---|---|---|---|
| `ui.notify` | Toast | none | dropped |
| `ui.confirm` | Modal with two actions | 5 min | resolves `false` |
| `ui.select` | Modal list | 5 min | resolves `undefined` |
| `ui.input` | Modal text field | 5 min | resolves `undefined` |
| `ui.setStatus`, `ui.setWorkingMessage` | Floating status line for the active session (v1 note: not inside the composer) | none | cleared |

Rules:

- One pending interactive prompt per session. A second call queues behind
  the first.
- Aborting the turn cancels pending prompts with the abort values above.
- Under remote control (Post-MVP) the prompt fails immediately with
  `UNSUPPORTED` until the remote protocol routes it; that routing is v3.
- Prompts show the extension label and source path so the user knows who is
  asking.

## 10. Protocol and IPC additions

No host-core RPC method, protocol version, or SQLite schema changes in v1.

### 10.1 Sidecar → main (host.proxy allowlist)

| Method | Purpose |
|---|---|
| `extensions.commands.publish` | Replace the session's registered command list |
| `extensions.ui.request` | One interactive or status call from §9 |
| `extensions.diagnostics.publish` | Replace the session's diagnostics list |
| `session.rename`, `session.create`, `session.fork`, `session.queuePush`, `session.queuePrioritize` | Existing methods, now reachable from the adapter |

### 10.2 Main ↔ renderer (Electron IPC)

| Channel | Direction | Purpose |
|---|---|---|
| `plugin/importExtension` | request | Native picker, generate the plugin, register it as a development plugin |
| `extensions/commands/run` | request | Run a registered command in the active session |
| `extensions/ui/respond` | request | Answer a pending prompt |
| `extensions/ui/prompt` | event | A prompt is pending |
| `extensions/event/status` | event | `ui.setStatus` / `ui.setWorkingMessage` text changed |
| `plugin/list` | request | Plugin rows carry `agentExtension` state, tool and command names, and diagnostics |
| `event/pluginChanged` | event | Also fires when a session publishes commands or diagnostics |

All channels are sender-validated like other plugin channels. The MCP
control plane exposes `extensions/commands/run` (write) and
`extensions/ui/respond` (dangerous, confirm required); the import is a native
picker and stays local. Main audits each prompt id in `logs/app/plugin.log`.

## 11. Plugin row surface

The Plugins page shows agent extensions on the owning plugin's row:

- The `agentExtension` capability chip and the `agent.extension` permission
  chip (high risk) beside the other capabilities and permissions.
- A details section with a state chip (`enabled` until a session loads the
  modules in this app run, `loaded`, `error`), the registered tool and slash
  command names, and the diagnostics: load errors, unsupported API calls
  with counts, rejected registrations, handler timeouts.
- "Import pi extension" in the page's overflow actions, guarded by a confirm
  that states what the grant means.

## 12. Phasing

| Phase | Content | Commitment |
|---|---|---|
| v1 | Loader, Runner per session, support matrix, events, tools, commands, UI bridge | Shipped (D387) |
| v1.1 | Modules become `contributes.agentExtensions` with the `agent.extension` grant; import of pi CLI extensions as development plugins; the standalone registry and settings tab are removed | Shipped (D388) |
| v2 | Custom session entries (`sendMessage`, `appendEntry`) with a schema bump and a generic renderer, `sessionManager` read shim, `switchSession`, editor read and write, autocomplete providers, `registerShortcut`, markdown transformers | Planned, needs a decision on entry persistence and compaction |
| v3 | `pi` package manifests and installation, read-only hints from the pi CLI's `settings.json`, unified skill and prompt discovery, remote-control routing for prompts, marketplace listing | Not scheduled |

v1 delivery order: bundling spike (E2E-245), shared protocol types, then the
runtime, main, and renderer tracks in parallel.

## 13. Versioning policy

- Upgrading any pi package upgrades all three together.
- A fixture set of sample extensions covering each supported member runs as a
  contract test on every upgrade.
- New `ExtensionAPI` members land in the Unsupported class with a
  diagnostic until a later decision moves them.
- Public documentation promises only the Supported and Supported-on-context
  classes in §5.

## 14. Open decisions

| Question | Default until decided |
|---|---|
| Should v2 custom entries persist to host-core and take part in compaction? | Persist; excluded from compaction summaries |
| Should v3 read the pi CLI's `settings.json` enabled paths as discovery hints? | Read-only hints, never written |
| Should extension tools be selectable per project like plugin tools? | Scope from §3.2 is the only gate |
