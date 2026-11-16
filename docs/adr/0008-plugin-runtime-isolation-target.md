# ADR 0008: Plugin runtime targets isolation in a separate process

- Status: Accepted (Implemented 2026-07-29)
- Date: 2026-07-25

## Context

Plugin code is untrusted. Running it inside the host process would let a plugin
crash or intrude on the host and hand it direct access to host objects and
environment.

## Decision

Each plugin main runs in a separate process (UtilityProcess / child process) and
reaches the Host API only over RPC: every `pi.*` call passes the host API
allowlist and the permission gateway before it reaches a host service. Plugins
receive a minimal environment, contribution points register by descriptor with
the callable half staying in the plugin process, and a dying plugin is
contained — pending calls reject with `PLUGIN_CRASHED`, contributions are
deregistered, and the renderer learns about it through `pluginChanged`.

Capability sandboxing (D009), resource limits, and load-time review of declared
manifest permissions remain future work.

## Consequences

- Plugins gain crash isolation and a narrower reachable surface, at higher
  implementation and debugging cost.
- A plugin must go through the RPC API; it holds no host object and no host
  process environment.
- Raw Node access inside the plugin process stays outside permission gating
  until D009 lands.

## Alternatives

- Run plugin code in the host process: rejected because one plugin failure
  would take the host down with it.
