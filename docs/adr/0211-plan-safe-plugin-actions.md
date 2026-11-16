# ADR 0211: Plan-Safe Plugin Actions for Read-Only Inspection

- Status: Accepted
- Date: 2026-09-10
- Deciders: PI-Desktop core
 - Amended by: D438 (the window-summon shortcut in §7 becomes one
  window-visibility toggle) and D439 (that toggle ships on `Alt+Shift+W`
  because macOS owns `Cmd+W`; the plan-safe plugin-action opt-in is unchanged)
 - Related: ADR 0052, ADR 0053, ADR 0170, E2E-PLAN-005

## Context

PI-Desktop splits sessions into Agent and Plan (and Goal) operating states. ADR
0052 and ADR 0053 lock the contract: Plan exposes `Read`, `Glob`, `Grep`,
`BrowserPreview` (workspace HTML preview), `Bash`, `EnterPlanMode`, and
`SubmitPlan`, and denies every plugin tool, `Write`, `Edit`, and unknown tools.

## Decision

### 1. Plugin tools declare plan-safe actions

A plugin tool may set a `planSafeActions` array on its registration descriptor
(in `packages/plugin-sdk`). The array lists the exact action strings the plugin
author considers safe in Plan and Goal modes.

The runtime validates the declaration at registration time. Every entry must be
a non-empty string.

### 2. Runtime filters plugin tools by mode

`packages/agent-runtime/src/runtime.ts` exposes a plugin tool to the model in
Agent mode the same way it does today. In Plan and Goal modes it exposes only
plugins whose `planSafeActions` is a non-empty array.

### 3. Runtime forwards the declaration to host-core

When the runtime calls `tools.execute` for a `plugin_*` tool it includes the
tool's `planSafeActions` list in the RPC params. Host-core treats the list as
part of the call's contract and forwards it to the desktop runner in the
`plugins.execute` notification alongside the session mode.

### 4. Host-core admits plan-safe plugin tools in contract modes

`crates/host-core/src/permissions.rs` retains the existing contract-mode hard
deny (`plan_mode_allows`) for `Write`, `Edit`, unknown tools, and plugin tools
that arrive without `planSafeActions`. A plugin tool that arrives with a
non-empty `planSafeActions` list now passes the contract gate.

### 5. Plugin-runtime enforces the action restriction

`apps/desktop/electron/main/plugin-runtime.ts` validates each plugin tool's
`planSafeActions` against its schema at registration and stores the normalized
list on `RegisteredPluginTool`. When the desktop runner receives a
`plugins.execute` notification it now carries the session mode in the `ctx`
argument to the tool's `execute`.

### 6. Bundled Browser plugin declares its four read-only actions

The bundled `pi.browser` plugin (ADR 0170) declares `planSafeActions:
["navigate", "snapshot", "screenshot", "console"]`. The mutating actions
(`click`, `fill`, `evaluate`, `cdp`) stay Agent-only, which matches the public
risk model and the user's expectation that "read the URL" is Plan-acceptable
while "fill in the form" is not.

### 7. Window-summon shortcut

The existing keyboard shortcut catalog gains a `summonWindow` id bound to
`Mod+Shift+W` by default, in the `window` group, alongside `closeWindow`
(`Mod+W`). The desktop main process registers it through `globalShortcut` the
same way it does `openPluginLauncher`, and the native menu gains a "bring the
window back" item that calls `restoreMainWindow`.

*(Amended by D438: the catalog now ships one `toggleWindow` id instead of the
`summonWindow` / `closeWindow` pair, the retired `Mod+Shift+W` chord is
registered by nothing, and stored overrides for the two retired ids are folded
into the toggle on read. Hiding is `Window.hide()` and never the close path.
Amended again by D439: the toggle ships on `Alt+Shift+W`, not on the `Mod+W`
this ADR's D438 amendment first named, because the key is registered
process-wide and macOS spends `Cmd+W` on its own close-window command.)*

## Consequences

- Plan and Goal modes can inspect external resources through any plugin whose
  author opts in.
- Plugin authors remain responsible for declaring exactly which actions are
  read-only.
- The contract modes' hard deny for `Write`, `Edit`, and unknown tools is
  unchanged.
- The defense-in-depth check in the plugin-runtime means a bug in the runtime or
  host-core cannot escalate a Plan call into a mutation: the plugin rejects it
  itself.
- The `Mod+Shift+W` summon shortcut pairs with `Mod+W` close, so users on
  Windows/Linux with a tray-residing window have one shortcut to hide and one to
  bring back.

## Alternatives

### Add a separate read-only URL fetcher tool

Rejected because it duplicates the Browser plugin's CDP-backed snapshot and
bypasses the public contribution channel; plugin authors would have to maintain
two copies of the same plumbing to expose the same capability in both modes.

### Allow all plugins in Plan mode and trust the manifest

Rejected because it weakens the contract and gives plugin authors an implicit
"everything is safe" default.

### Use a per-tool risk-only flag

Rejected because plugin tools are not uniformly read-only across actions.

### Auto-detect safe actions from the schema

Rejected because "no `Write` argument" is not the same as "no side-effect".

### Default `summonWindow` to a tray-only affordance

Rejected because the tray icon already summons on click; the request was a
keyboard shortcut to do the same thing without leaving the current focus.

## References

- `docs/spec/03-runtime/03-tools-and-permissions.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` E2E-PLAN-005
 - `docs/spec/08-meta/decisions-log.md` D384, D438
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
