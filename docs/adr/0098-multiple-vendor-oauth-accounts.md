# ADR 0098: Treat every vendor OAuth account as an independent provider row

- Status: Accepted for implementation
- Date: 2026-08-18
- Related: ADR 0095, D027, D028, D031, D240

## Context

The first vendor-account implementation used the pi-ai vendor id as the local
identity, so Electron main kept one provider row and one `CredentialStore` per
vendor and a second sign-in could only reuse the first account. The renderer also
showed OAuth rows both in the AI provider list and in a Vendor accounts card, and
sign-out cleared the credential but left the row. Multiple accounts for one vendor
are a real requirement, and the account boundary must be the security boundary
because tokens must never cross between accounts.

## Decision

The provider row id is the account identity: every successful login starts a new
`authKind: "oauth"` row even when another row shares the `vendorKey`, and the
credential lives only at `secret:provider:<providerId>:oauth`. Each row gets its
own `MutableModels` instance and `CredentialStore`, which accepts the builtin
vendor id only inside that instance and maps it to the row-specific secret ref;
refresh serialization is keyed by row id, so concurrent accounts cannot overwrite
each other's token. The Vendor accounts card owns the lifecycle: it lists every
local account, allows the picker to be used repeatedly, and removes an account
through `providers.delete`, which clears the row, OAuth secret, API-key secret, and
secret metadata together, while a row without a credential stays visible as
`Needs sign-in`. The AI services list holds API-key and custom or no-auth services
only; connected OAuth rows still feed the default-model selector and runtime but
are edited only from Vendor accounts. Sidecar bindings store only the row ids
allowed for a session and validate `provider.resolveAuth` against that set, and a
subagent aliased by vendor name resolves only when it names one row.

## Consequences

- Several rows for one vendor coexist with a stable ordinal, and removing the
  default account repairs the default to the first remaining ready provider.
- Existing OAuth rows stay readable after upgrade; the next sign-in adds a row.
- No schema version is needed: the renderer uses `providers/oauth/delete`, which
  delegates to the existing host provider deletion contract.

## Alternatives

- Share one credential per vendor with labels: the vendor-keyed store would let one
  account overwrite the other.
- Clear only the OAuth secret on removal: leaves an unusable row and a stale
  default identity.
