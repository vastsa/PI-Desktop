# ADR 0214: Trusted extensions run in the Agent sidecar

- Status: Accepted (v1 implemented 2026-09-10)
- Date: 2026-09-10
- Decision: D387
- Related: ADR 0002, ADR 0008, D007, `07-plugins/16-trusted-extensions.md`,
  `07-plugins/01-plugin-system.md` §14

## Context

PI-Desktop's plugin system (ADR 0008) runs plugins in their own process behind a
permission gateway. That is the right shape for distributed, untrusted code, but
it leaves no surface for code that must sit on the agent loop itself: tools that
execute in-process with the session's working directory, hooks on every turn,
tool call, and provider request, and slash commands that carry session context.

## Decision

1. **Trusted extensions are the second extension surface.** The sidecar pins
   `pi-coding-agent` at the same version as the other two kernel packages as a
   types-only dependency, mirrors its discovery rules, loads modules with
   `jiti/static` and virtual modules, and implements `ExtensionAPI` on top of
   the desktop runtime's hook points in a desktop-owned Runner.
2. **Trusted, opt-in, no auto-import.** Extensions are labelled "Trusted
   extension", run with sidecar trust, and are disabled until the user enables
   each one.
3. **Explicit support classes.** Every `ExtensionAPI` member is Supported,
   Deferred, or Unsupported.
4. **Plugins are untouched.** No plugin manifest, permission, or process
   boundary changes.
5. **No host-core change in v1.** Enablement is app settings; new traffic is
   sidecar-to-main proxy methods and Electron IPC only.

## Consequences

### Prompt chaining amendment (2026-09-29, issue #1023)

The desktop initially folded `before_agent_start` results while giving every
handler the original prompt.

This matches the sequential prompt replacement behavior of the pinned Pi
extension runner without sharing mutable handler inputs.

### General consequences

- Users can attach in-process tools, hooks, and commands to the agent loop
  without a new app release.
- Two extension surfaces coexist and are explained in user documentation as
  "plugins" (sandboxed) and "trusted extensions" (in-sidecar).
- The three kernel packages move in lockstep; a contract test with sample
  extensions guards every upgrade.
- The sidecar bundle must keep jiti loadable; this is verified first.
- Module-level extension state is shared across sessions in one sidecar.

## Alternatives considered

- A new plugin contribution type for in-process hooks.
- Replace the desktop runtime with `AgentSession`.
- Run extensions inside the plugin host process.
