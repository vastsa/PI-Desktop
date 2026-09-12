# ADR 0211: Plan-Safe Plugin Actions for Read-Only Inspection

- Status: Accepted
- Date: 2026-09-10
- Deciders: PI-Desktop core
- Related: ADR 0052, ADR 0053, ADR 0170, E2E-PLAN-005

## Context

PI-Desktop splits sessions into Agent and Plan (and Goal) operating states.
ADR 0052 and ADR 0053 lock the contract: Plan exposes `Read`, `Glob`,
`Grep`, `BrowserPreview` (workspace HTML preview), `Bash`, `EnterPlanMode`,
and `SubmitPlan`, and denies every plugin tool, `Write`, `Edit`, and unknown
tools. Plugin agent tools are Agent-only contributions; their mutating
actions (click, fill, evaluate, raw CDP, etc.) are exactly what the contract
is meant to keep Plan mode from doing.

The cost of that hard line shows up whenever the planner needs to read the
outside world. A user who asks Plan mode to "look at the company's bug
tracker and tell me what to change" gets back a request for the URL instead
of the bug list, because Plan mode cannot open the `pi.browser` plugin or any
other inspection-capable plugin. The same gap covers MCP tools that only
fetch URLs, search archives, or read calendar entries: read-only at the
protocol level, Agent-only by current policy.

The fix is not to loosen the contract. The contract is correct: Plan mode
must not click, fill, evaluate, or send arbitrary CDP. The fix is to let a
plugin declare, with the same rigor as the host permission gate, which of
its actions are safe enough to call in Plan mode, and to enforce that
declaration in three places (the runtime that hides unsafe tools, the host
that admits safe ones, and the plugin that actually executes) so a
mis-declaration cannot turn a Plan call into a mutation.

## Decision

### 1. Plugin tools declare plan-safe actions

A plugin tool may set a `planSafeActions` array on its registration
descriptor (in `packages/plugin-sdk`). The array lists the exact action
strings the plugin author considers safe in Plan and Goal modes. Omitting
the field, or sending an empty array, keeps the existing "plugin tools are
Plan-denied" behavior; no plugin gets Plan access it did not explicitly
opt into.

The runtime validates the declaration at registration time. Every entry
must be a non-empty string. When the schema's `properties.action` is an
enum, every entry must be one of the enum values; a misaligned declaration
fails registration instead of becoming a Plan-time bypass.

### 2. Runtime filters plugin tools by mode

`packages/agent-runtime/src/runtime.ts` exposes a plugin tool to the model
in Agent mode the same way it does today. In Plan and Goal modes it
exposes only plugins whose `planSafeActions` is a non-empty array. The
plugin tool's `description` is annotated with the allowed action list so
the model knows which actions it can actually call. The full plugin tool
is still available to the renderer (skill catalog, plugin page); the
filter is on the agent-visible tool list, not on registration.

### 3. Runtime forwards the declaration to host-core

When the runtime calls `tools.execute` for a `plugin_*` tool it includes
the tool's `planSafeActions` list in the RPC params. Host-core treats the
list as part of the call's contract and forwards it to the desktop runner
in the `plugins.execute` notification alongside the session mode.

### 4. Host-core admits plan-safe plugin tools in contract modes

`crates/host-core/src/permissions.rs` retains the existing contract-mode
hard deny (`plan_mode_allows`) for `Write`, `Edit`, unknown tools, and
plugin tools that arrive without `planSafeActions`. A plugin tool that
arrives with a non-empty `planSafeActions` list now passes the contract
gate. The list does not change any other rule: low-risk auto-allow, the
external-path prompt, session grants, and the `auto` mode permission
posture all apply the same way they do for any Agent-mode plugin call.

### 5. Plugin-runtime enforces the action restriction

`apps/desktop/electron/main/plugin-runtime.ts` validates each plugin
tool's `planSafeActions` against its schema at registration and stores
the normalized list on `RegisteredPluginTool`. When the desktop runner
receives a `plugins.execute` notification it now carries the session
mode in the `ctx` argument to the tool's `execute`. In `plan` and `goal`
mode the runner rejects the call with `PERMISSION_DENIED` if the
declared list is empty or the call's `action` is not in the list. This
check is the third layer: even a runtime or host-core bug that let an
unsafe call through cannot reach the plugin.

### 6. Bundled Browser plugin declares its four read-only actions

The bundled `pi.browser` plugin (ADR 0170) declares
`planSafeActions: ["navigate", "snapshot", "screenshot", "console"]`. The
mutating actions (`click`, `fill`, `evaluate`, `cdp`) stay Agent-only,
which matches the public risk model and the user's expectation that
"read the URL" is Plan-acceptable while "fill in the form" is not.

### 7. Window-summon shortcut

The existing keyboard shortcut catalog gains a `summonWindow` id bound to
`Mod+Shift+W` by default, in the `window` group, alongside `closeWindow`
(`Mod+W`). The desktop main process registers it through `globalShortcut`
the same way it does `openPluginLauncher`, and the native menu gains a
"bring the window back" item that calls `restoreMainWindow`. The shortcut
is the symmetrical counterpart to `closeWindow`: closing a window hides
it to the tray or minimizes it; summoning brings the same window back to
focus.

## Consequences

- Plan and Goal modes can inspect external resources through any plugin
  whose author opts in. The bundled Browser plugin is the first
  beneficiary; MCP tools can do the same with the same declaration.
- Plugin authors remain responsible for declaring exactly which actions
  are read-only. A wrong declaration fails at plugin registration, not
  at the user's prompt.
- The contract modes' hard deny for `Write`, `Edit`, and unknown tools
  is unchanged. A plugin that does not declare `planSafeActions` keeps
  the ADR 0052 / ADR 0053 behavior.
- The defense-in-depth check in the plugin-runtime means a bug in the
  runtime or host-core cannot escalate a Plan call into a mutation: the
  plugin rejects it itself.
- The `Mod+Shift+W` summon shortcut pairs with `Mod+W` close, so users
  on Windows/Linux with a tray-residing window have one shortcut to
  hide and one to bring back.

## Alternatives

### Add a separate read-only URL fetcher tool

Rejected because it duplicates the Browser plugin's CDP-backed snapshot
and bypasses the public contribution channel; plugin authors would have
to maintain two copies of the same plumbing to expose the same
capability in both modes.

### Allow all plugins in Plan mode and trust the manifest

Rejected because it weakens the contract and gives plugin authors an
implicit "everything is safe" default. The opt-in `planSafeActions`
field makes the safety claim an explicit, validated part of the
plugin's registration.

### Use a per-tool risk-only flag

Rejected because plugin tools are not uniformly read-only across actions.
The Browser plugin is the obvious example: `navigate + snapshot` is
safe, `click + fill` is not. A per-tool boolean would either under-grant
(by hiding safe tools) or over-grant (by exposing unsafe actions).

### Auto-detect safe actions from the schema

Rejected because "no `Write` argument" is not the same as "no
side-effect". The schema cannot tell that a navigation will trigger a
login flow, that an `evaluate` will post a comment, or that a snapshot
will sign the user in. The plugin author owns that knowledge.

### Default `summonWindow` to a tray-only affordance

Rejected because the tray icon already summons on click; the request
was a keyboard shortcut to do the same thing without leaving the
current focus. The `Mod+Shift+W` binding is symmetrical with
`closeWindow` (`Mod+W`) so it is discoverable from the existing menu.

## References

- `docs/spec/03-runtime/03-tools-and-permissions.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` E2E-PLAN-005
- `docs/spec/08-meta/decisions-log.md` D384
- `packages/plugin-sdk/src/index.ts`
- `packages/agent-runtime/src/runtime.ts`
- `packages/agent-runtime/src/mode-prompts.ts`
- `crates/host-core/src/tools/mod.rs`
- `crates/host-core/src/permissions.rs`
- `crates/host-core/src/rpc/mod.rs`
- `apps/desktop/electron/main/plugin-runtime.ts`
- `apps/desktop/electron/main/index.ts`
- `apps/desktop/resources/plugins/pi.browser/main.js`
- `packages/shared/src/keyboard-shortcuts.ts`
- `packages/shared/src/protocol.ts`
- `apps/desktop/electron/main/application-menu.ts`
