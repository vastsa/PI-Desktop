# Provider Request example

A trusted agent extension that reads the host's ready model catalogue and issues
one authenticated request to a provider row the user configured.

- `contributes.agentExtensions`: `src/index.ts`
- permissions: `agent.extension`, `models.list`, `provider.request`

## Try it

1. Load this folder as a development plugin.
2. Confirm the two high-risk grants (`agent.extension`, `provider.request`).
3. In a session running in Agent mode, type `/provider_ping`.

The command lists the ready models through `ctx.modelRegistry.getAvailable()`,
then calls `GET <provider.baseUrl>/models` through `ctx.providers.request` and
reports the status. The host resolves the credential from the provider row and
sets the credential header itself, so the extension never sees a key.

## Read next

- [Plugin development guide](../../../docs/plugin-development.md) §6.12
- [Trusted extensions](../../../docs/spec/07-plugins/16-trusted-extensions.md) §5.1
- [Permission matrix](../../../docs/spec/07-plugins/13-plugin-permissions-matrix.md)
