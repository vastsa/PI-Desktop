# ADR 0320: Host-owned OAuth lifecycle for plugin providers

- Status: Accepted for implementation
- Date: 2026-10-06
- Decision: D647
- Related: ADR 0008, ADR 0095, ADR 0259,
  `07-plugins/13-plugin-permissions-matrix.md`,
  `03-runtime/14-secrets-storage.md`

## Context

ADR 0259 gives plugins manifest-owned provider rows with API-key and no-auth
support only, yet some providers need OAuth. The host already owns provider
account UI, encrypted secrets, request authentication, and cancellation, and a
plugin adding a provider must not move those responsibilities into its panel or
into Electron main, while a general secret API would create a second secret
owner.

## Decision

`contributes.providers` gains `authKind: "oauth"` and bounded `oauth` display
metadata, requiring `provider.register`, `provider.oauth`, an absolute HTTP(S)
`baseUrl`, and an `onProviderOAuth` export that runs in the existing isolated
plugin process (ADR 0008). The host owns the sign-in surface, prompts,
progress, and authorization URL, and the plugin uses `pi.providers.oauth.prompt`
and `.notify` only during its active login. `onProviderOAuth` handles `login`
and `refresh` with an abort signal for cancellation, unload, and timeout, and
refresh sees only the credential of its own declared contribution, because no
general secret read API is added. Electron main stores the credential under the
encrypted `secret:provider:<providerRowId>:oauth` reference and serializes
refreshes by provider row, the host validates token, header, and result sizes,
renderer events carry only login UI state and a non-secret account label, and
the Agent Runtime receives only the access token through the normal
per-request auth resolver. `provider.oauth` is a separate high-risk permission
from `provider.register` and `net.fetch`, host-mediated callback egress still
needs `net.fetch` and `manifest.net.domains`, and one credential is stored per
contribution, with sign-out clearing the secret but keeping the manifest row.
Existing `api_key` and `none` contributions keep their behavior, and missing
permissions or a missing callback fail closed.

## Consequences

- A plugin can integrate an OAuth-only provider into the native provider and
  model selection paths without a second provider registry.
- The trusted callback sees its own access and refresh tokens, an exposure the
  high-risk permission review states explicitly and encryption cannot mitigate
  once delivered.
- Host-owned prompts, secret storage, refresh serialization, and request-auth
  delivery stay with their existing owners, and each contribution holds one
  account at a time.

## Alternatives

- A general secret-store API: rejected, it exposes unrelated credentials and
  creates a second secret owner.
- Running plugin OAuth code inside Electron main: rejected, it puts arbitrary
  plugin code beside renderer, window, and host capabilities.
