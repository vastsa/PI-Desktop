# 14. Secrets Storage

## 1. Goal

Store provider credentials and future sensitive tokens safely under Rust host ownership, with zero raw secret leakage to renderer logs/UI persistence.

## 2. Ownership

| Concern | Owner |
|---|---|
| secret write/read/delete | Rust host-core |
| secret metadata index | SQLite `secrets_meta` |
| OS secure storage integration | Rust host-core |
| vendor-account login/refresh orchestration | Electron main (`oauth.ts`) |
| renderer knowledge | `hasSecret` / `hasOauth` booleans and a non-secret account label |

Node pi sidecar may receive secret **ephemerally in-memory** for a run via host RPC, never persisted by sidecar. For a vendor-account provider it receives even less: a short-lived `ModelAuth` resolved per request, never the OAuth refresh token (§10).

## 3. Backends

### Primary
- **Electron/OS safe storage style backend** mediated by host
- macOS: Keychain-backed path preferred for first release

### Fallback
If primary backend unavailable:
1. encrypt secret blob with machine-local key material
2. store ciphertext under app data
3. mark `backend=file_fallback` in metadata
4. surface security warning in settings

MVP must implement both paths with automatic selection.

## 4. Data model

```ts
type SecretMeta = {
  secretRef: string
  providerId?: string
  kind: "api_key" | "bearer_token" | "azure_api_key" | "custom"
  backend: "safeStorage" | "file_fallback"
  updatedAt: string
}

// raw value never appears in SQLite tables
// raw value never appears in IPC list/get provider responses
```

`secretRef` formats:

```text
secret:provider:<providerId>:api_key
secret:provider:<providerId>:oauth
```

The two refs are independent, so one provider row may hold an API key, a vendor
account, or both. The OAuth ref stores the serialized pi-ai `OAuthCredential`
(access token, refresh token, expiry) written through the generic `secrets.set`
path, so it is encrypted by the same backend but is not indexed in
`secrets_meta`; provider delete clears both refs and any metadata row for them.

## 4a. Provider readiness flags

| flag | meaning |
|---|---|
| `hasSecret` | the row has **either** credential — an API key or a vendor account |
| `hasOauth` | the row has a vendor-account credential |
| `oauthAccountLabel` | non-secret display label for the signed-in account (from `config_json.oauth.accountLabel`) |

`hasSecret` deliberately stayed the single readiness signal, so model pickers,
composer guards, and provider lists needed no new condition when vendor
accounts arrived. `hasOauth` only drives presentation: the account badge, and
hiding the API key input on a vendor row.

## 5. Host RPC

- `secrets.set` `{ secretRef, value, meta }`
- `secrets.delete` `{ secretRef }`
- `secrets.has` `{ secretRef } -> boolean`
- `secrets.getForRuntime` `{ secretRef, reason, runId }` **internal only** (main/host → not exposed to renderer)

### Renderer-facing surface
Renderer uses provider methods that accept optional `secretValue` on create/update and only reads `hasSecret`.

## 6. Access rules

1. Renderer cannot list raw secrets
2. Logs redaction: mask values matching secret patterns / known secret refs
3. `getForRuntime` requires active run context and is audited
4. Export excludes secrets by default
5. Uninstall/reset app deletes secrets unless future explicit migrate tool says otherwise
6. Provider delete defaults to deleting linked secret — both the API key and the OAuth credential
7. An OAuth refresh token never crosses a process boundary: only Electron main reads it, and only to mint request auth

## 7. Redaction policy

Never write to logs:
- Authorization headers
- api keys
- bearer tokens
- query params named `key`/`token`/`api_key`

Replace with:
```text
***REDACTED***
```

## 8. Failure modes

| case | behavior |
|---|---|
| set fails | provider update fails atomically if secret required |
| backend downgrades to fallback | warn once per session in settings |
| missing secret at run | `PROVIDER_SECRET_MISSING` |
| decrypt failure | treat as missing + prompt re-enter |

## 9. Acceptance criteria

- [ ] set/has/delete works on native macOS arm64 and Intel x64 paths
- [ ] renderer never receives raw secret on provider list/get
- [ ] runtime can fetch secret ephemerally for a turn
- [ ] logs do not contain raw key material in normal failure tests
- [ ] fallback backend works when primary unavailable (dev/test harness)
- [ ] a vendor-account row reports `hasSecret` and `hasOauth` without exposing the credential

## 10. Vendor-account credentials

Electron main owns login, account-removal, and refresh orchestration (ADR 0095,
D237, D240)
because pi-ai declares it app-owned. `oauth.ts` implements pi-ai's
`CredentialStore` on top of `secrets.getForRuntime` / `secrets.set` /
`secrets.delete`, serializing `modify` per provider so pi-ai's locked-refresh
assumption holds across concurrent turns. Each OAuth provider row gets its own
collection and store scope; two rows with the same vendor key never share a
credential or refresh lock.

Request auth flows one way only:

1. The launch payload for an `authKind: "oauth"` row carries `apiKey: ""`.
   Main does not read the credential at launch.
2. Per request, the runtime calls the host-proxy method
   `provider.resolveAuth` with `{ sessionId, providerId }`.
3. Electron main answers it locally — the call is **never forwarded to
   host-core** — after checking the pair against the per-launch binding table.
   An unbound provider fails with `PROVIDER_NOT_BOUND`.
4. The reply is a short-lived `ModelAuth` (`apiKey`, `headers`, `baseUrl`),
   refreshed under the store lock only when it has expired.

The sidecar therefore holds a revocable, roughly hour-long token scoped to the
one provider its session is bound to — strictly less than the long-lived API
key it receives for a keyed row.
