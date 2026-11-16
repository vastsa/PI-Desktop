# ADR 0320: Host-owned OAuth lifecycle for plugin providers

- Status: Accepted for implementation
- Date: 2026-10-06
- Decision: D647
- Related: ADR 0008, ADR 0095, ADR 0259, `07-plugins/02-plugin-manifest-schema.md`, `07-plugins/03-plugin-api.md`, `07-plugins/04-plugin-security.md`, `07-plugins/13-plugin-permissions-matrix.md`, `03-runtime/14-secrets-storage.md`

## Context

ADR 0259 gives plugins manifest-owned provider rows, but its first version
supports only API keys and no-auth providers. Some providers can only be used
through OAuth.

## Decision

1. Add `authKind: "oauth"` and bounded `oauth` display metadata to
   `contributes.providers`.
2. The Host owns the sign-in surface and lifecycle.
3. `onProviderOAuth` handles `login` and `refresh`, and receives an abort signal
   for cancellation, plugin unload, and timeout.
4. Electron main stores the credential under the existing encrypted
   `secret:provider:<providerRowId>:oauth` reference and serializes refreshes by
   provider row.
5. `provider.oauth` is a separate high-risk permission from `provider.register`
   and `net.fetch`.
6. One credential is stored per provider contribution.
7. Existing `api_key` and `none` provider contributions keep their behavior; old
   plugins receive no OAuth grant by default.

## Consequences

- A plugin can integrate an OAuth-only provider into the native provider and
  model selection paths without adding a second provider registry.
- The trusted callback sees its own access and refresh tokens.
- Host-owned prompts, secret storage, refresh serialization, renderer
  projection, and request-auth delivery remain under their existing owners.
- Each contribution has one account at a time.
- The OAuth callback is plugin-authored code and remains subject to the plugin
  process trust boundary documented in the security specification.

## Alternatives considered

### Give plugins a general secret-store API

Rejected: it would expose unrelated provider credentials, require a new
secret-reference authorization model, and let a plugin become a second secret
owner.

### Run plugin OAuth code inside Electron main

Rejected: loading third-party OAuth libraries into Electron main would break the
existing process boundary and put arbitrary plugin code beside renderer, window,
and host-process capabilities.

### Store OAuth tokens in plugin-private storage

Rejected: the Host could not serialize refreshes, clear credentials on sign-out
or provider removal, report a connected account without reading plugin data, or
keep the runtime auth resolver authoritative.

### Create one provider row per plugin OAuth account

Deferred: it changes provider identity, manifest reconciliation, default-model
selection, and uninstall cleanup.
