# ADR 0214: Trusted extensions run in the Agent sidecar

- Status: Accepted (v1 implemented 2026-09-10)
- Date: 2026-09-10
- Decision: D387
- Related: ADR 0002, ADR 0008, D007, `07-plugins/16-trusted-extensions.md`,
  `07-plugins/01-plugin-system.md` §14

## Context

PI-Desktop's plugin system (ADR 0008) runs plugins in their own process behind
a permission gateway. That is the right shape for distributed, untrusted code,
but it leaves no surface for code that must sit on the agent loop itself:
tools that execute in-process with the session's working directory, hooks on
every turn, tool call, and provider request, and slash commands that carry
session context. The desktop runtime in
`packages/agent-runtime/src/runtime.ts` already exposes these hook points
internally; nothing lets a user attach code to them.

The kernel packages `pi-ai` and `pi-agent-core` (ADR 0002) have a sibling,
`pi-coding-agent`, that defines an `ExtensionAPI` contract and a loader for
TypeScript extension modules. Adopting that contract gives PI-Desktop a
second extension surface with an existing, documented API and an existing
body of extensions written against it.

Three routes were evaluated: implement `ExtensionAPI` over the desktop
runtime; express the same capabilities as a new plugin contribution type; or
replace the desktop runtime with `pi-coding-agent`'s `AgentSession`.

## Decision

1. **Trusted extensions are the second extension surface.** The sidecar pins
   `pi-coding-agent` at the same version as the other two kernel packages as
   a types-only dependency, mirrors its discovery rules, loads modules with
   `jiti/static` and virtual modules, and implements `ExtensionAPI` on top
   of the desktop runtime's hook points in a desktop-owned Runner. One
   Runner per session. (The upstream `ExtensionRunner` binds the terminal
   theme and is not reused.)
2. **Trusted, opt-in, no auto-import.** Extensions are labelled "Trusted
   extension", run with sidecar trust, and are disabled until the user enables
   each one. D007 is unchanged: `~/.pi` is scanned for candidates, never
   imported. Project-scoped extensions are enabled per project.
3. **Explicit support classes.** Every `ExtensionAPI` member is Supported,
   Deferred, or Unsupported. Unsupported members are inert and produce
   diagnostics; they never throw. Terminal-UI surfaces stay Unsupported.
4. **Plugins are untouched.** No plugin manifest, permission, or process
   boundary changes. Extension tools and commands enter the same catalogs
   plugins use, after plugins, and lose name collisions.
5. **No host-core change in v1.** Enablement is app settings; new traffic is
   sidecar-to-main proxy methods and Electron IPC only.

## Consequences

- Users can attach in-process tools, hooks, and commands to the agent loop
  without a new app release.
- Two extension surfaces coexist and are explained in user documentation as
  "plugins" (sandboxed) and "trusted extensions" (in-sidecar).
- The three kernel packages move in lockstep; a contract test with sample
  extensions guards every upgrade.
- The sidecar bundle must keep jiti loadable; this is verified first.
- Module-level extension state is shared across sessions in one sidecar.

## Alternatives considered

- A new plugin contribution type for in-process hooks. Rejected: it would
  either punch through the plugin sandbox or duplicate `ExtensionAPI` under a
  second name with no existing extensions to run.
- Replace the desktop runtime with `AgentSession`. Rejected for now: it
  discards the desktop's modes, plans, deferred tools, and subagent logic,
  and terminal-UI surfaces remain unusable regardless. Kept as a long-term
  option.
- Run extensions inside the plugin host process. Rejected: the permission
  gateway would deny most of what extensions do, and they would fail at load.
