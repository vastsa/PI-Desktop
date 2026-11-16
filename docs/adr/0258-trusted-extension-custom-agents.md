# ADR 0258: Trusted extensions may provide custom agents

- Status: Accepted for implementation
- Date: 2026-09-15
- Decision: D426
- Related: ADR 0214, ADR 0215, `07-plugins/16-trusted-extensions.md`, Issue #401

## Context

Trusted extensions run beside the Agent runtime and are the appropriate surface
for providers that cannot be represented by a built-in pi-ai adapter. Issue #401
asks for model selection and custom agent/provider registration so a plugin can
integrate services such as Command Code with its own endpoint and authentication
flow.

## Decision

1. Add a PI-Desktop `registerAgent` ExtensionAPI member.
2. Keep the registration in the Agent sidecar.
3. Use namespaced `extension-agent:<encoded-agent-key>` provider ids.
4. Expose a read-only model registry projection to the extension context.
5. `registerProvider` accepts the same plugin-owned streaming shape as a
   compatibility alias.
6. Registration is session-scoped and is removed with the runtime.

## Consequences

- Command Code and similar integrations can implement their own auth and wire
  protocol without an app release or a new Rust transport.
- Session model selection remains host-owned and observable through the existing
  `session:modelChanged` event.
- Custom agent definitions are not visible in the ordinary provider Settings
  picker; a plugin may expose its own command or UI to select them.
- Trusted extension code has sidecar-level authority by design.
- The public ExtensionAPI contract is PI-Desktop-specific for `registerAgent`;
  upstream pi API upgrades must preserve the adapter contract or add a
  compatibility translation.

## Alternatives considered

### Expose pi-coding-agent ModelRegistry directly

Rejected: it exposes credential resolution and assumes pi's persistence model.

### Add every custom provider to Rust/SQLite

Rejected: the plugin owns the implementation and credentials, while Host storage
must not persist opaque plugin transport code or secrets.

### Register an executable subagent instead

Deferred to a separate API.
