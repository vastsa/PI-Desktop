# ADR 0320: Host-owned OAuth lifecycle for plugin providers

- Status: Accepted for implementation
- Date: 2026-10-06
- Decision: D647
- Related: ADR 0008, ADR 0095, ADR 0259, `07-plugins/02-plugin-manifest-schema.md`, `07-plugins/03-plugin-api.md`, `07-plugins/04-plugin-security.md`, `07-plugins/13-plugin-permissions-matrix.md`, `03-runtime/14-secrets-storage.md`

## Context

ADR 0259 gives plugins manifest-owned provider rows, but its first version
supports only API keys and no-auth providers. Some providers can only be used
through OAuth. The host already owns provider account UI, encrypted secrets,
request authentication, and cancellation; allowing a plugin to add a provider
must not move those responsibilities into its panel or into Electron main.

OAuth also creates a new permission boundary: the plugin that implements an
OAuth protocol must handle its own access and refresh tokens. A general secret
API would expose unrelated credentials and create a second secret owner.

## Decision

1. Add `authKind: "oauth"` and bounded `oauth` display metadata to
   `contributes.providers`. Such a contribution requires `provider.register`,
   `provider.oauth`, an absolute HTTP(S) `baseUrl`, and an `onProviderOAuth`
   export from the plugin main module. The callback runs in the existing
   isolated plugin process (ADR 0008), never in Electron main.
2. The Host owns the sign-in surface and lifecycle. Vendor accounts lists the
   loaded plugin provider, the host renders prompts and progress, and the host
   opens an authorization URL after validating it. The plugin uses
   `pi.providers.oauth.prompt` and `.notify` only during its active login.
3. `onProviderOAuth` handles `login` and `refresh`, and receives an abort signal
   for cancellation, plugin unload, and timeout. Login returns a credential;
   refresh receives and returns only the credential for the same declared
   contribution. No general secret read API is added.
4. Electron main stores the credential under the existing encrypted
   `secret:provider:<providerRowId>:oauth` reference and serializes refreshes by
   provider row. The Host validates token, header, and result sizes. Renderer
   events contain only login UI state and a non-secret account label. The
   Agent Runtime receives only the access token through the normal per-request
   auth resolver; the refresh token remains in Electron main and the Host
   secret store.
5. `provider.oauth` is a separate high-risk permission from `provider.register`
   and `net.fetch`. Host-mediated callback egress still requires `net.fetch` and
   `manifest.net.domains`. Plugin entry code is not an OS sandbox, so granting
   `provider.oauth` means trusting the plugin code with that provider's
   credential.
6. One credential is stored per provider contribution. Sign out clears the
   OAuth secret but leaves the manifest-owned row. Multi-account plugin
   providers would need separately owned account rows and are not part of this
   contract. Plugin-owned rows and secrets remain excluded from portable
   configuration capture.
7. Existing `api_key` and `none` provider contributions keep their behavior;
   old plugins receive no OAuth grant by default. Missing permissions or a
   missing callback fail closed without changing an existing plugin's
   enablement or other provider rows.

## Consequences

- A plugin can integrate an OAuth-only provider into the native provider and
  model selection paths without adding a second provider registry.
- The trusted callback sees its own access and refresh tokens. That exposure is
  explicit in the high-risk permission review and is not mitigated by encrypted
  storage once a token is delivered to the callback.
- Host-owned prompts, secret storage, refresh serialization, renderer projection,
  and request-auth delivery remain under their existing owners.
- Each contribution has one account at a time. Supporting multiple accounts
  requires a future account identity and row-lifecycle design.
- The OAuth callback is plugin-authored code and remains subject to the plugin
  process trust boundary documented in the security specification.

## Alternatives considered

### Give plugins a general secret-store API

Rejected: it would expose unrelated provider credentials, require a new
secret-reference authorization model, and let a plugin become a second secret
owner. The callback can access only its own declared provider credential.

### Run plugin OAuth code inside Electron main

Rejected: loading third-party OAuth libraries into Electron main would break
the existing process boundary and put arbitrary plugin code beside renderer,
window, and host-process capabilities. The callback remains in the plugin's
existing isolated process.

### Store OAuth tokens in plugin-private storage

Rejected: the Host could not serialize refreshes, clear credentials on sign-out
or provider removal, report a connected account without reading plugin data, or
keep the runtime auth resolver authoritative.

### Create one provider row per plugin OAuth account

Deferred: it changes provider identity, manifest reconciliation, default-model
selection, and uninstall cleanup. The initial contract keeps the manifest row
stable and stores one account credential beneath it.


The later ADR `plugin-managed-native-transcripts` adds a separate, permission-gated plugin-private encrypted store. It does not expand OAuth callbacks to read host/provider secret references.
