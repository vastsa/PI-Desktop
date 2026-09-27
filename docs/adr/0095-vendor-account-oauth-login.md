# ADR 0095: Sign in with a vendor account instead of pasting an API key

- Status: Accepted for implementation
- Date: 2026-08-18
- Deciders: PI-Desktop core
- Related: D237, D240, ADR 0098, D028, D031, ADR 0012, ADR 0020, ADR 0027

## Context

A provider row could only be authenticated one way: the user pastes an API key,
host-core encrypts it under `secret:provider:<id>:api_key`, and Electron main
reads the plaintext back on every launch so the sidecar can sign requests with a
constant `{ auth: { apiKey } }`. Users who already pay for a vendor
subscription — Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot — had to buy
separate API credit to use PI-Desktop at all.

`@earendil-works/pi-ai` already ships everything the protocol side needs: seven
OAuth flows, a `CredentialStore` contract, and locked token refresh. What it
does not ship is the host half — its own `auth/types.d.ts` says "The app
persists a credential after login via `modify(...)`. Login/logout orchestration
is app-owned." PI-Desktop had no such half.

Two properties made this more than an extra settings field. Vendor access
tokens expire in about an hour, so a credential resolved once at launch goes
stale mid-session. And a refresh token is materially more dangerous than an API
key: it mints new credentials on demand, so the existing "read the secret and
hand it to the sidecar at launch" pattern was not acceptable for it.

## Decision

1. **The credential is a second secret on the same provider row.** OAuth
   credentials serialize to JSON and are stored through the existing encrypted
   secret store under `secret:provider:<id>:oauth`, beside — never instead of —
   `secret:provider:<id>:api_key`. `has_secret` widens to mean "has either
   credential", so every readiness check in the renderer keeps working
   unchanged; a new `has_oauth` distinguishes the two for badges and for hiding
   the key input. `auth_kind` gains the value `oauth`; it was already a free
   string, so neither the host protocol version nor the storage schema changes.

2. **Login orchestration lives in Electron main, in `oauth.ts`.** It implements
   `CredentialStore` over host-core's `secrets.*` RPC, serializing `modify` per
   provider so pi-ai's locked-refresh assumption holds, and bridges pi-ai's
   `AuthInteraction` to renderer events over five new invoke channels and one
   event channel under `pi-desktop/providers/oauth/*`. Browser-callback,
   device-code, select and paste-a-code steps are all the same event stream, so
   the renderer renders what the vendor asked for rather than a per-vendor
   script, and cancel aborts the local callback server or the polling loop.

3. **The vendor list is derived, not enumerated.** Cards come from
   `models.getProviders().filter(p => p.auth.oauth)`, so all seven vendors are
   supported on day one and a vendor that gains or loses a flow in pi-ai needs
   no change here. Because `auth/oauth/load.js` loads flows through a dynamic
   import with a variable specifier — a path electron-vite cannot bundle — main
   calls `registerBunOAuthFlows()` once at startup to register them statically.

4. **The sidecar resolves auth per request and never sees a refresh token.**
   An OAuth row's launch payload carries `apiKey: ""`. The runtime injects a
   `resolveAuth` callback that calls a new host-proxy method,
   `provider.resolveAuth`, which main answers itself and never forwards to
   host-core; main validates the `(sessionId, providerId)` pair against the
   binding table it rewrites on every launch and refuses anything else. The
   reply is a short-lived `ModelAuth` — `apiKey`, `headers`, `baseUrl` — which
   pi-ai passes straight through, so Copilot's per-account endpoint and Kimi's
   header-only auth need no special case. pi-ai calls `getAuth` on every stream
   and caches nothing, and refreshes only past expiry under the store lock, so
   this is both correct and cheap.

5. **A vendor row's identity stays stable across turns.** `matches()` compares
   the provider row, whose `apiKey` is permanently `""`; a fresh `resolveAuth`
   closure per launch is a function property and disappears through
   `JSON.stringify`. An OAuth session therefore reuses its warm runtime instead
   of rebuilding it once an hour, or once a turn.

6. **Model discovery and connection tests go through the account.** For an
   OAuth row, `providers.listModels` reads the authenticated catalog
   (`models.getAvailable`, which applies the vendor's own `filterModels`, so
   Copilot shows what the subscription actually includes) instead of probing
   `/models` with a key it does not have, and the connection test proves the
   account by resolving auth. Login stores a non-secret account label in the row
   config and picks the row's `apiStyle` from the selected model — a vendor may
   span wire APIs. The original one-row-per-vendor assumption is amended by
   ADR 0098: every login now creates an independent row and credential scope.
   Two styles are added for this: `openai_codex_responses` and `pi_messages`.

## Consequences

- A subscriber signs in from Settings → Model configuration and picks models
  normally; no API credit is required for the seven supported vendors.
- The privilege boundary tightens rather than loosens. The sidecar previously
  received a long-lived API key unconditionally; for a vendor row it now
  receives a revocable, roughly hour-long token for the one provider its
  session is bound to, and no refresh token at all.
- Vendor logins depend on main being alive to answer `provider.resolveAuth`;
  a host or main restart mid-turn fails the request rather than signing it with
  a stale token, which is the intended failure direction.
- API-key rows are untouched: same storage, same launch payload, same resolve
  path. The two credential kinds remain in the same provider storage domain;
  each OAuth account owns its own provider row and secret ref (ADR 0098).

## Alternatives

- **Resolve the credential once at launch and put it in the payload.**
  Rejected: a Codex token expires in about an hour, so long sessions would
  break mid-turn; refreshing would change the payload and make `matches()` miss
  every turn, rebuilding the runtime and discarding warm state; and it would
  put a token the user never typed into a process that runs model-directed
  code.
- **Give the sidecar the credential store and let pi-ai refresh in-process.**
  Rejected: that hands the refresh token — the durable secret — to the least
  trusted process, and contradicts the existing host-proxy allowlist rule that
  the sidecar must not be able to pull secrets or mutate configuration.
- **Store OAuth credentials in a new dedicated table or file.** Rejected: the
  encrypted secret store already provides the exact guarantees needed, and a
  second backend would need its own lifecycle, deletion path, and audit.
- **Ship two or three vendors first.** Rejected: the list is derived from
  pi-ai's catalog, so restricting it would have meant writing a hardcoded
  allowlist — more code for less coverage.

## References

- `docs/spec/03-runtime/11-provider-model-system.md`
- `docs/spec/03-runtime/12-provider-config-schema.md`
- `docs/spec/03-runtime/14-secrets-storage.md`
- `docs/spec/03-runtime/01-ipc-protocol.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `apps/desktop/electron/main/oauth.ts`, `apps/desktop/electron/main/agent-sidecar.ts`
- `packages/agent-runtime/src/provider-binding.ts`
- `crates/host-core/src/secrets.rs`, `crates/host-core/src/providers.rs`
- Decision D237, D028, D031
