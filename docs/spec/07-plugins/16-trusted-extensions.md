# 16. Trusted Extensions

> Status: Implemented v1.1 (D387 / D388, ADR 0214 / ADR 0215 / ADR 0244); implementation notes are marked "v1 note"
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

This contract describes extensions attached to Desktop Agent sessions. The
Desktop adapter implements the explicit subset in §5–6; new upstream events do
not become actionable here automatically. Native Pi continuation runs the
coding-agent SDK's own extension lifecycle and can use its 0.87.1 boundary
hooks, subject to the separate native-session lease and trust rules in
[ADR 0254](../../adr/0254-native-pi-session-continuation.md).

Provider declarations are a separate manifest surface rather than part of this
contract: `contributes.providers` materializes Host-owned provider rows
([02-plugin-manifest-schema.md](02-plugin-manifest-schema.md) §5.4, ADR 0259),
so it is neither an `ExtensionAPI` member nor a row in the §5 support matrix.
`registerProvider` (§5) remains the session-scoped extension counterpart.

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

### 3.2 Importing a pi CLI extension or skill package

Plugins → "Import pi extension" opens a native picker (main owns the path,
D344) for an explicit local file or directory. Main copies the selected
source under `<dataDir>/plugins/imported/<slug>/src/`, writes a generated
CommonJS no-op `main.cjs` and a manifest with id `imported.<slug>` (a unique suffix is
added for repeated imports), and registers the directory through the existing
local-plugin flow. The confirmation before the picker remains the trust
decision; the generated manifest declares the permissions needed by its actual
contributions. The manifest's `main` points to `main.cjs` regardless of the
source package's `type`; both copied package declarations retain their module
semantics. Loading an imported plugin whose `main` is the generated CommonJS
`main.js` wrapper rewrites that file in place to `main.cjs` and updates the
manifest; copied package files, grants, and activation scope stay as they are.
The rewrite matches only the generated no-op (including the original comment
text). A customized `main.js` is left untouched. Re-importing without removal
creates a separate plugin with a unique suffix; it does not copy grants or
activation scope from the older copy.

For extension files and packages without `pi.skills`, entry discovery keeps
the existing `pi-coding-agent` rules: `package.json` `pi.extensions`, otherwise
`index.ts` / `index.js`, otherwise loose `*.ts` / `*.js` files one level deep.
A package that explicitly declares `pi.skills` and has no `pi.extensions` (or
an empty array) is skill-only: incidental scripts, including `index.js`, are
copied as resources but never promoted to executable agent extensions.

A directory that ships a `package.json` also has it (plus its npm lockfile)
copied to the plugin root with any `workspaces` field stripped. When it declares
production or optional dependencies, main performs a bounded two-step install:
it first resolves `npm install --package-lock-only --omit=dev --legacy-peer-deps
--no-audit --no-fund --ignore-scripts`, validates the complete generated lockfile,
then runs `npm ci` with the same safety flags. Direct specs in `dependencies`,
`optionalDependencies`, `devDependencies`, and `peerDependencies` must be
registry-only because npm may inspect all four; the git resolver is disabled.
No lifecycle script runs. Failed installs remove partial dependencies/cache and
are reported to the renderer without blocking the import. The confirm discloses
the npm step alongside the skills disclosure.

If npm or its Node.js runtime is unavailable, the installer returns a structured
unavailable error. Only this category opens a native Main-owned message box with
"Choose npm" and "Cancel"; ordinary registry, network, dependency-policy, or
installation errors never open an executable-path prompt. The message explains
that npm must come from a trusted Node.js installation, that the choice is
remembered for future imports, and that Node.js must be installed first if absent.
Choosing npm opens a native executable picker with `showHiddenFiles`, allowing
navigation into installations such as `~/.nvm`. On macOS, `noResolveAliases`
preserves the selected `bin/npm` symlink rather than returning its internal CLI
target, so the sibling `node` remains discoverable. Selected paths never come
from renderer text input.

Main validates the selected executable and its Node.js runtime with bounded
version checks before saving or installing. The checks share the installation
budget and stop at a bounded ceiling, because a slow machine must not report a
working npm as unavailable and send the user back to the picker. Invalid
selections (including npm without usable Node.js) show a localized native
warning and let the user choose again or cancel; the guidance is to choose npm
in the same directory as `node`.
Only a validated selection is persisted, atomically, in Main-owned
`<dataDir>/npm-path.json`, not renderer settings or Host SQLite. Future imports
reuse it after validation; a stale saved path returns to the recovery prompt.
If persistence fails, a native warning explains that the choice could not be
saved but the current import can still use the validated executable.

The selected executable's directory is added only to the install child's `PATH`
so npm can find `node`; no shell startup probing or global environment mutation
is permitted. Version checks and installation retain a minimal environment with
no inherited credentials. The registry-only proxy, isolated npm configuration,
bounded two-step install, disabled git resolution, and disabled lifecycle scripts
remain unchanged. Configured Windows `.cmd`/`.bat` launchers use the adjacent
`node.exe` and `node_modules/npm/bin/npm-cli.js` directly, without shell
interpolation; a nonstandard launcher missing this layout is rejected with
recovery guidance. Recovery retries dependency installation in the already-generated
plugin directory: it never recopies the source or allocates another plugin id.
After recovery succeeds, is cancelled (including closing the picker), or ends in
a dependency error, the generated plugin is loaded and registered exactly once;
dependency errors remain visible without blocking registration.

All native recovery labels use the active locale's flat `plugins.npmMissingTitle`,
`npmMissingBody`, `npmChoose`, `npmPickerTitle`, `npmInvalidTitle`, `npmInvalidBody`,
`npmSaveFailedTitle`, and `npmSaveFailedBody` keys, plus existing `common.cancel`.
Bodies are standalone localized text without interpolation placeholders; Main
appends any dynamic diagnostic on a new line.

| Source | Becomes |
|---|---|
| A pi extension directory or file | A local plugin under `plugins/imported`, id `imported.<slug>` |
| A plugin package declaring `contributes.agentExtensions` | Installed like any plugin; the grant is asked for at install |
| A `package.json` with `pi.extensions` | Entries under `src/`, exposed through `contributes.agentExtensions` with `agent.extension` |
| A `package.json` with `pi.skills` | Markdown documents under `src/`, exposed through `contributes.skills` with `agent.prompt.inject` |
| A skill-only package | A no-op plugin holding `agent.prompt.inject`, without `agent.extension` |

`pi.skills` is an array of at most 32 nonempty relative Markdown-file or
directory paths. An explicit `.md` file contributes that document. For a
directory, its own `SKILL.md` takes precedence; otherwise directly contained
`.md` files are included and subdirectories are searched for `SKILL.md`.
Nested skill directories stop at their own `SKILL.md`, so support documents
are not turned into extra skills. Scanning skips dot-prefixed entries and
`node_modules`, deduplicates documents, and has a budget of 256 directories.
More than 32 discovered skills, a missing declaration, or an unsupported
path fails the import rather than silently yielding an incomplete catalog.
Each contribution has an explicit, stable plugin-local ID derived from its
package-relative path; different directories named `SKILL.md` remain
independent skills. Normal plugin skill parsing, size limits, grants, and
unload behavior remain in force.

Copying uses paths relative to the selected package. A package installed
under an ancestor `node_modules` directory is copied normally; only its own
`node_modules` directory segments are excluded. References, assets, helper
scripts, and other ordinary source files remain under `src/`, preserving
skill-relative resource paths. Credential files (`.env*`, `.npmrc`, `.netrc`,
`.pypirc`, private-key and certificate files) and repository metadata directories
are not copied. The selected root is resolved to its real path. Contribution
paths must stay inside that root, cannot traverse `..`, and cannot point into
its dependency directories. Absolute `pi.skills` paths and descendant symbolic
links are rejected. Copying also rejects symbolic links among retained resources
and removes a partial copy on failure. The generated destination is created
atomically and must not be inside the selected source.

This is an explicit local import, not a pi CLI package manager. It never
automatically scans or imports `~/.pi`, does not read the CLI's installed
package registry, and does not run npm lifecycle scripts. When dependencies
are declared, the bounded installer accepts only registry version specs and
registry-resolved npm lockfiles, rejects unsafe package locations and nested
dependency specs, disables git resolution, and isolates npm's config/cache from
the user's credentials and proxy settings. Importing a package does not promise
that every third-party extension dependency can execute.

## 4. Loading and runtime

## 4. Loading and runtime

### 4.1 Where extensions run

Extensions load inside the Agent sidecar process (`packages/agent-runtime`),
never in Electron main, the renderer, or a plugin host process.

### 4.2 Loader

- The sidecar pins `@earendil-works/pi-coding-agent` at exactly the version
  pinned for `pi-ai` and `pi-agent-core`. The three versions must match; CI
  fails when they drift. Native Pi sessions run its extension loader
  in process, so the pin is a bundled runtime dependency and not a
  types-only contract.
- The loader mirrors the `pi-coding-agent` discovery rules and uses
  `jiti/static` with `virtualModules`, so the babel transform is bundled
  and no path resolution happens at runtime. The bundling step is verified
  by a contract test that runs the bundle outside the repository (E2E-245).
- The bundle is built with `--define:PI_BUNDLED_NODE=true`. The
  `pi-coding-agent` extension loader embeds the kernel modules and
  `typebox` for a compiled binary, for a bundled Node distribution, and
  for its own TypeScript-source runtime; every other Node build resolves
  them from the importing file, which a packaged install
  (`resources/agent-runtime/`) cannot satisfy. An entry point that
  bundles pi's session or extension loader in process needs the same
  define.
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
| Supported | `registerTool`, `registerCommand`, `registerAgent`, `registerProvider` (plugin-owned compatibility alias; same shape as `registerAgent`), `unregisterAgent`, `unregisterProvider`, `on(...)` for every event in §6, `exec`, `getActiveTools`, `getAllTools`, `setActiveTools`, `getCommands`, `setModel` (configured models and plugin agents; idle-only; persists the current session binding), `getThinkingLevel`, `setThinkingLevel`, `setSessionName`, `getSessionName`, `sendUserMessage` (Host-owned queue, D386), `getFlag` |
| Supported on context | `ui.notify`, `ui.confirm`, `ui.select`, `ui.input`, `ui.setStatus`, `ui.setWorkingMessage`, `cwd`, `modelRegistry`, `isIdle`, `abort`, `hasPendingMessages`, `getContextUsage`, `compact`, `getSystemPrompt`, `waitForIdle`, `newSession`, `fork` |
| Deferred to v2 | `sendMessage`, `appendEntry`, `setLabel`, `sessionManager` read API, `switchSession`, `registerShortcut`, `registerMarkdownTransformer`, `ui.setEditorText`, `ui.getEditorText`, `ui.addAutocompleteProvider`, `registerFlag` value editing |
| Unsupported | `ui.setWidget`, `ui.setFooter`, `ui.setHeader`, `ui.setTitle`, `ui.custom`, `ui.overlay`, `ui.onTerminalInput`, `ui.setWorkingVisible`, `ui.setWorkingIndicator`, `ui.setHiddenThinkingLabel`, `ui.pasteToEditor`, `ui.editor`, `registerMessageRenderer`, `registerEntryRenderer`, `navigateTree`, `shutdown` |

`registerAgent({ id, name?, models, stream? | complete? })` registers a
session-scoped plugin-owned LLM integration. Each model declares bounded public
metadata (`id`, display name, API label, modalities, reasoning and limits). The
plugin callback receives the pi-ai model/context/options and owns endpoint,
authentication, request serialization, and response conversion. It must honor
`options.signal` for cancellation. `complete` is adapted to a one-result stream.

The host assigns `extension-agent:<encoded-agent-key>` as the provider id. A
successful idle `setModel` persists that provider/model pair through
`session.configure`; the next turn reloads the trusted extension and restores the
agent implementation. `modelRegistry` exposes only models and auth availability;
it never exposes Host API keys, secret refs, OAuth tokens, arbitrary Host headers,
or Host provider internals. `registerProvider` and its unregister counterpart
accept the same plugin-owned shape as a compatibility alias — a `stream` or
`complete` implementation, in the upstream `(id, config)` form and in the object
form; provider credentials in the upstream config are ignored by Host and are
not persisted.

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
| `before_agent_start` | Before the first provider request of a turn | Yes, system prompt replacement only |
| `context` | `prepareNextTurn` | Yes, replacement message list |
| `before_provider_request`, `before_provider_headers`, `after_provider_response` | Provider call wrapper | Request return value; headers mutate the payload in place |
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

Desktop event capabilities are maintained in
`packages/agent-runtime/src/extensions/event-capabilities.ts`: result,
mutation, notification, or deferred. Registering a deferred event remains
accepted but emits an `unsupported_api` diagnostic in the existing plugin
diagnostics; it does not prevent supported handlers from loading.

Every event handler, including startup, shutdown, and notifications, has a
30-second **per-handler** wait budget. Module loading and factory initialization
also have separate 30-second wait budgets, reported as load/factory errors.
A handler that throws or times out produces a diagnostic and counts as
`undefined`; subsequent handlers still run in registration order. Existing
result folding and fail-open semantics are unchanged. This is not a mandatory
security-check mechanism. Multiple stalled handlers can each consume their budget.

Abort retires pending event dispatches. Disposal first rejects new dispatches
and cancels existing waits, then runs shutdown once even under concurrent
disposal. Old dispatches return no result and never invoke their remaining
handlers; late settlements do not add diagnostics or overwrite results. A
factory finishing after disposal cannot publish tools or commands. Runtime
shutdown cancels agent work before waiting for extension shutdown. Stopping
during preflight hooks prevents the provider request and retains the user
message; a later prompt can run normally.

Each invocation now owns an abort signal exposed as `ctx.signal`. Finishing,
timing out, stopping or disposing retires that invocation. SDK calls from its
late callbacks are rejected, including commands waiting for idle, session creation,
fork or queue admission. An already admitted Host transaction is not rolled back;
late completion cannot start a subsequent queue-priority update or mutate runtime
model state. Commands and tool executions have no event-style 30-second limit:
they may run until completion, their supplied signal aborts, Stop, or disposal.
Tool updates/results after retirement are discarded; accepted updates and results
are detached before publication so later extension mutations cannot rewrite them.
SDK `exec` owns its process group/tree and terminates it on scope retirement or
its explicit timeout;
disposal waits for tracked process cleanup, with cleanup failures diagnosed.
Processes deliberately escaping the group and direct Node API spawns are outside
this ownership contract.

Result-bearing hook inputs and outputs are detached copies. Header mutations
are committed only after a handler succeeds within its budget. Late in-place
mutations cannot alter the caller's payload or another handler's input.

These are cooperative lifecycle boundaries, not forced execution isolation:
trusted code may still block the JS thread or use direct Node APIs for external
side effects. Native Pi sessions use the upstream SDK lifecycle and are outside
this Desktop change. See ADR `trusted-extension-operation-ownership`.
The 30-second event budget also applies when a handler waits for a UI prompt;
the UI broker's own prompt timeout does not extend that budget.

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
- Every new sidecar UI request has an invocation-owned request ID. Cancellation
  targets that ID plus the session/extension identity, drops queued requests,
  and sends retirement for the exact visible prompt to the renderer. Stale
  cancellation cannot close a later request. Legacy requests without IDs retain
  session-wide cancellation. Settled queue tails are released.
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
| `extensions.model.configure` | Validate and persist a plugin-owned provider/model binding through `session.configure`, then broadcast `session:modelChanged` |
| `session.rename`, `session.create`, `session.fork`, `session.queuePush`, `session.queuePrioritize` | Existing methods, now reachable from the adapter |

### 10.2 Main ↔ renderer (Electron IPC)

| Channel | Direction | Purpose |
|---|---|---|
| `plugin/importExtension` | request | Native picker, generate the plugin, register it as a development plugin |
| `extensions/commands/run` | request | Run a registered command in the active session |
| `extensions/ui/respond` | request | Answer a pending prompt |
| `extensions/ui/prompt` | event | A prompt is pending |
| `extensions/event/status` | event | `ui.setStatus` / `ui.setWorkingMessage` text changed |
| `plugin/list` | request | Plugin rows carry `agentExtension` state, tool, command, custom-agent names, and diagnostics |
| `event/pluginChanged` | event | Also fires when a session publishes commands, diagnostics, or model binding changes |

All channels are sender-validated like other plugin channels. The MCP
control plane exposes `extensions/commands/run` (write) and
`extensions/ui/respond` (dangerous, confirm required); the import is a native
picker and stays local. Main audits each prompt id in `logs/app/plugin.log`.

## 11. Plugin row surface

The Plugins page shows agent extensions on the owning plugin's row:

- The `agentExtension` capability chip and the `agent.extension` permission
  chip (high risk) beside the other capabilities and permissions.
- A details section with a state chip (`enabled` until a session loads the
  modules in this app run, `loaded`, `error`), the registered tool, slash
  command and custom-agent names, and the diagnostics: load errors, unsupported
  API calls with counts, rejected registrations, handler timeouts.
- "Import pi extension" in the page's overflow actions, guarded by a confirm
  that states what the grant means.

## 12. Phasing

| Phase | Content | Commitment |
|---|---|---|
| v1 | Loader, Runner per session, support matrix, events, tools, commands, UI bridge | Shipped (D387) |
| v1.1 | Modules become `contributes.agentExtensions` with the `agent.extension` grant; import of pi CLI extensions as development plugins; the standalone registry and settings tab are removed | Shipped (D388) |
| v1.1 amendment | Plugin-owned custom agents via `registerAgent`, provider compatibility alias, redacted model registry, idle-only session binding and restore through `extension-agent:` ids | Implemented (D426 / ADR 0258) |
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


## Trusted renderer host

Trusted renderer entries are separate from the agent host specified above. Their first supported surfaces are composer completion and reference lifecycle callbacks. The host draws these surfaces; arbitrary component slots are not included. See [Composer references](17-composer-references.md).
