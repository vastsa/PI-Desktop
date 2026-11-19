# ADR 0215: Agent extensions are a plugin contribution

- Status: Accepted (implemented 2026-09-11)
- Date: 2026-09-11
- Decision: D388 (amends D387 / ADR 0214)
- Related: ADR 0008, ADR 0214, `07-plugins/16-trusted-extensions.md`,
  `07-plugins/13-plugin-permissions-matrix.md`

## Context

ADR 0214 delivered ExtensionAPI modules beside plugins, with their own discovery,
enablement store, and Settings destination, so users had two lists meaning
"extend the agent" and pi CLI extensions stayed outside install, scope, update,
and removal.

## Decision

A plugin lists ExtensionAPI modules in `contributes.agentExtensions` and must hold
the `agent.extension` permission (high risk, explicit confirmation), because those
modules still run in the Agent sidecar outside the plugin sandbox; validation
rejects the contribution without it, and a grant list that omits it skips the
modules with an audit entry. Plugin lifecycle owns enablement, per-project scope,
reload, and removal. "Import pi extension" copies the chosen file into
`<dataDir>/plugins/imported/<slug>/src`, writes a manifest with the contribution
and permission, and registers it as a development plugin, with the confirm before
the picker as the trust decision. The standalone surface is removed — no registry
file, no Settings destination, no registry IPC — leaving the plugin row with its
capability, permission, load state, names, and diagnostics, and marketplace
distribution waits for signing.

## Consequences

- Users get one model: extensions are plugins, so the ecosystem gap closes with
  "import as a plugin".
- The sidecar engine is untouched and the sandbox level is unchanged, now
  explicit as a permission.

## Alternatives considered

- Keep two surfaces and cross-link them: rejected by the maintainer.
- Source-convert extensions into plugin main modules: rejected; in-process
  ExtensionAPI semantics do not map onto the sandboxed plugin API.
