# ADR 0008: Plugin runtime targets isolation in a separate process

- Status: Accepted (Implemented 2026-07-29)
- Date: 2026-07-25

## Context

Plugin code is untrusted; we must prevent it from dragging down or intruding into the host.

## Decision

Target architecture: the plugin main runs in a **separate process** (UtilityProcess/Child Process) and accesses the Host API via RPC.

If MVP progress is constrained, a lighter isolation may be adopted temporarily, but it must not break:

- The permission gateway
- The API allowlist
- Unified registration of contribution points
- Crash non-fatality

The temporary solution and its migration plan must be noted in the implementation ADR.

## Rationale

1. Crash isolation
2. Clearer permission proxying
3. Resource limits can be added later

## Consequences

### Positive
- Better security and stability

### Negative
- Higher implementation and debugging cost

## Implementation (2026-07-29)

The target architecture shipped; no transitional in-main runtime remains.

- `apps/desktop/electron/main/plugin-host-process.mjs` is the per-plugin entry,
  forked with `utilityProcess.fork` (one process per plugin, bundled to
  `out/main/plugin-host-process.js`). It receives a minimal environment, so the
  host's shell env and provider keys never reach plugin code.
- `apps/desktop/electron/main/plugin-runtime.ts` became the broker: it keeps the
  registry of commands/tools, and every `pi.*` call arrives as RPC, passes
  `HOST_API_ALLOWLIST`, then `assertPermission`, then the host service, then the
  audit log. Plugin code holds no host object and no `require` of host modules.
- Contribution points register by descriptor only; the callable half stays in the
  plugin process and is invoked back over RPC with a timeout (command 30s, tool
  110s, lifecycle hook 5s, load 15s).
- A dying plugin process is contained: pending calls reject with
  `PLUGIN_CRASHED`, contributions are deregistered, the panel closes, and the
  renderer gets a toast plus `pluginChanged`.
- `onUnload` now runs (in the child) before the process is killed.

Known limits, deliberately out of this change:

- The plugin process is a Node environment; permission gating covers the `pi.*`
  surface, not raw `require("node:fs")` inside the plugin process. Capability
  sandboxing (D009) remains future work.
- Resource limits (CPU/memory) are not enforced yet.
- Declared manifest permissions are still auto-granted at load time.
