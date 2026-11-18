# ADR 0211: Plan-Safe Plugin Actions for Read-Only Inspection

- Status: Accepted
- Date: 2026-09-10
- Amended by: D438 (the window-summon shortcut in §7 becomes one
  window-visibility toggle) and D439 (that toggle ships on `Alt+Shift+W`
  because macOS owns `Cmd+W`; the plan-safe plugin-action opt-in is unchanged)
- Related: ADR 0052, ADR 0053, ADR 0170, D384, E2E-PLAN-005

## Context

ADR 0052 and ADR 0053 make Plan and Goal expose `Read`, `Glob`, `Grep`,
`BrowserPreview`, `Bash`, `EnterPlanMode`, and `SubmitPlan` and deny every plugin
tool, `Write`, `Edit`, and unknown tool. That line blocks legitimate inspection:
a planner asked to look at a bug tracker or an MCP calendar source cannot open
any inspection-capable plugin. The contract is right — Plan must not click,
fill, evaluate, or send raw CDP — so the fix is a validated per-plugin
declaration, not a looser gate.

## Decision

### 1. Plugin tools declare plan-safe actions

A plugin tool may set a `planSafeActions` array of action strings on its
registration descriptor in `packages/plugin-sdk`; omitting it or sending an empty
array keeps plugins Plan-denied. Registration rejects empty entries and entries
outside the schema's `properties.action` enum instead of accepting a
mis-declaration.

### 2. Runtime filters plugin tools by mode

`packages/agent-runtime/src/runtime.ts` exposes only plugins with a non-empty
`planSafeActions` list in Plan and Goal, annotating the tool description with the
allowed actions; the renderer keeps the full catalog.

### 3. Runtime forwards the declaration to host-core

A `plugin_*` call carries `planSafeActions` in the `tools.execute` params, and
host-core forwards it to the desktop runner in the `plugins.execute`
notification together with the session mode.

### 4. Host-core admits plan-safe plugin tools in contract modes

`plan_mode_allows` in `crates/host-core/src/permissions.rs` still hard-denies
`Write`, `Edit`, unknown tools, and plugin tools without `planSafeActions`, while
a non-empty list passes the contract gate. No other rule changes: low-risk
auto-allow, the external-path prompt, session grants, and the `auto` posture apply
as for any Agent-mode plugin call.

### 5. Plugin-runtime enforces the action restriction

`apps/desktop/electron/main/plugin-runtime.ts` validates each declaration
against its schema, stores the normalized list on `RegisteredPluginTool`, and
passes the session mode in the `ctx` given to `execute`, rejecting the call with
`PERMISSION_DENIED` when the action is not declared in `plan` or `goal` mode.
This third layer means a runtime or host-core bug cannot reach the plugin.

### 6. Bundled Browser plugin declares its four read-only actions

`pi.browser` (ADR 0170) declares `planSafeActions: ["navigate", "snapshot",
"screenshot", "console"]`, keeping `click`, `fill`, `evaluate`, and `cdp`
Agent-only.

### 7. Window-summon shortcut

The shortcut catalog gains a `summonWindow` id bound to `Mod+Shift+W` in the
`window` group, registered through `globalShortcut` with a native menu item
calling `restoreMainWindow`, as the counterpart to `closeWindow` (`Mod+W`).
Amended by D438 and D439: the catalog now ships one `toggleWindow` id instead of
the pair, the retired chord is registered by nothing, stored overrides fold into
the toggle on read, hiding uses `Window.hide()` and never the close path, and the
toggle ships on `Alt+Shift+W` because the key is process-wide and macOS spends
`Cmd+W` on its own close-window command.

## Consequences

- Plan and Goal can inspect external resources through any plugin that opts in;
  MCP tools take the same path with the same declaration.
- A wrong declaration fails at registration rather than at the user's prompt, and
  the hard deny for `Write`, `Edit`, and unknown tools is unchanged.
- The plugin runtime's own check means a runtime or host-core bug cannot escalate
  a Plan call into a mutation.

## Alternatives

- Add a separate read-only URL fetcher: rejected; it duplicates the Browser
  plugin's snapshot path and bypasses the public contribution channel.
- Use a per-tool risk flag or auto-detect safe actions from the schema: rejected;
  plugin actions are not uniformly read-only and a schema cannot know that a
  navigation triggers a login or that `evaluate` posts a comment.
