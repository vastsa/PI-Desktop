# ADR 0215: Agent extensions are a plugin contribution

- Status: Accepted (implemented 2026-09-11)
- Date: 2026-09-11
- Decision: D388 (amends D387 / ADR 0214)
- Related: ADR 0008, ADR 0214, `07-plugins/16-trusted-extensions.md`,
  `07-plugins/02-plugin-manifest-schema.md` §4, `07-plugins/13-plugin-permissions-matrix.md`

## Context

ADR 0214 delivered ExtensionAPI modules as a separate surface next to plugins:
its own discovery over `~/.pi/agent/extensions`, its own enablement store, its
own Settings destination. That gave users two lists that mean "extend the agent"
and left pi CLI extensions outside the plugin lifecycle (install, scope, update,
remove, marketplace).

## Decision

1. **`contributes.agentExtensions` + `agent.extension`.** A plugin lists
   ExtensionAPI modules in its manifest and must hold the `agent.extension`
   permission (high risk, explicit confirmation).
2. **Plugin lifecycle owns enablement and scope.** Enabling, disabling,
   per-project activation, reload, and removal are the plugin's.
3. **Import generates a plugin.** "Import pi extension" copies the chosen file
   or directory into `<dataDir>/plugins/imported/<slug>/src`, writes a manifest
   with the contribution and the permission, and registers it as a development
   plugin.
4. **The standalone surface is removed.** No registry file, no Settings
   destination, no list / enable / rescan / add-path / remove IPC.
5. **Marketplace distribution waits for signing.** `agent.extension` is accepted
   from local imports and development plugins in v1.1.

## Consequences

- One mental model for users: extensions are plugins.
- The sidecar engine (loader, Runner, hooks, command and prompt bridges) is
  untouched; only the ownership layer moved.
- Sandbox level is unchanged and now explicit as a permission.
- The v1 harness covers plugin-form fixtures and the importer/runtime contracts;
  the native picker, npm install, and provider-turn journey remain separate
  environment-dependent validation.

## Alternatives considered

- Keep two surfaces and cross-link them.
- Source-convert pi extensions into plugin main modules.
