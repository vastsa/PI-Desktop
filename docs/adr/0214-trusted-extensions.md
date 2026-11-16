# ADR 0214: Trusted extensions run in the Agent sidecar

- Status: Accepted (v1 implemented 2026-09-10)
- Date: 2026-09-10
- Related: ADR 0002, ADR 0008, D007, D387

## Context

The plugin system (ADR 0008) runs plugins in their own process behind a permission
gateway, which leaves no surface for code that must sit on the agent loop itself:
in-process tools, hooks on turns, tool calls, and provider requests, and slash
commands carrying session context. The kernel's sibling `pi-coding-agent` package
already defines an `ExtensionAPI` contract and loader with existing extensions
written against it.

## Decision

1. **Trusted extensions are the second extension surface.** The sidecar pins
   `pi-coding-agent` as a types-only dependency, mirrors its discovery rules,
   loads modules with `jiti/static` and virtual modules, and implements
   `ExtensionAPI` over the desktop runtime's hook points in a desktop-owned
   Runner, one per session.
2. **Trusted, opt-in, no auto-import.** Extensions are labelled "Trusted
   extension", run with sidecar trust, and stay disabled until the user enables
   each one. D007 still holds: `~/.pi` is scanned for candidates, never imported,
   and project-scoped extensions are enabled per project.
3. **Explicit support classes.** Every `ExtensionAPI` member is Supported,
   Deferred, or Unsupported; unsupported members stay inert and produce
   diagnostics instead of throwing, and terminal-UI surfaces stay Unsupported.
4. **Plugins are untouched.** No manifest, permission, or process boundary
   changes; extension tools and commands join the same catalogs after plugins and
   lose name collisions.
5. **No host-core change in v1.** Enablement is app settings, and the new traffic
   is sidecar-to-main proxy methods plus Electron IPC.

## Consequences

- Users attach in-process tools, hooks, and commands without an app release, and
  documentation separates sandboxed plugins from in-sidecar trusted extensions.
- The three kernel packages move in lockstep, guarded by a contract test with
  sample extensions.
- Module-level extension state is shared across sessions in one sidecar.
- The prompt-chaining amendment of 2026-09-29 (issue #1023) chains
  `before_agent_start` string replacements through a turn-local payload in the
  existing order, starting fresh each turn, so two extensions appending to the
  same input no longer overwrite each other.

## Alternatives

- A new plugin contribution type for in-process hooks: rejected because it would
  breach the plugin sandbox or duplicate `ExtensionAPI` with no extensions to run.
- Run extensions in the plugin host process: rejected because the permission
  gateway denies most of what extensions do.
