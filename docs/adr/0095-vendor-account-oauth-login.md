# ADR 0095: Sign in with a vendor account instead of pasting an API key

- Status: Accepted for implementation
- Date: 2026-08-18
- Related: D237, D240, ADR 0098, D028, D031, ADR 0012, ADR 0020, ADR 0027

## Context

A provider row could only be authenticated by pasting an API key, encrypted under
`secret:provider:<id>:api_key` and read back by Electron main at launch so the
sidecar could sign with a constant `{ auth: { apiKey } }`. Subscribers to Claude
Pro/Max, ChatGPT Plus/Pro, or GitHub Copilot therefore had to buy separate API
credit. pi-ai already ships the OAuth flows, the `CredentialStore` contract, and
locked refresh, but explicitly leaves login and logout orchestration to the app,
and PI-Desktop had no such half. Vendor tokens expire in about an hour and a
refresh token mints credentials on demand, so a credential resolved once at
launch was neither fresh enough nor safe enough.

## Decision

1. **The credential is a second secret on the same provider row.** OAuth
   credentials are stored through the existing encrypted secret store under
   `secret:provider:<id>:oauth`, beside — never instead of —
   `secret:provider:<id>:api_key`; `has_secret` widens to "either credential",
   `has_oauth` distinguishes them, and `auth_kind` gains `oauth`, so neither the
   host protocol version nor the storage schema changes.
2. **Login orchestration lives in Electron main, in `oauth.ts`.** It implements
   `CredentialStore` over host-core's `secrets.*` RPC, serializing `modify` per
   provider so pi-ai's locked-refresh assumption holds, and bridges
   `AuthInteraction` to the renderer over `pi-desktop/providers/oauth/*`
   channels, so the renderer renders whatever the vendor asked for rather than a
   per-vendor script.
3. **The vendor list is derived, not enumerated.** Cards come from
   `models.getProviders().filter(p => p.auth.oauth)`, and main calls
   `registerBunOAuthFlows()` once at startup because pi-ai loads flows through a
   variable dynamic import that electron-vite cannot bundle.
4. **The sidecar resolves auth per request and never sees a refresh token.** An
   OAuth row's launch payload carries `apiKey: ""`; the runtime injects a
   `resolveAuth` callback answered by a new host-proxy method,
   `provider.resolveAuth`, which main answers itself against the session binding
   table and refuses for anything else, replying with a short-lived `ModelAuth`
   carrying `apiKey`, `headers`, and `baseUrl`.
5. **A vendor row's identity stays stable across turns.** `matches()` compares
   the provider row, whose `apiKey` is permanently `""`, so an OAuth session
   reuses its warm runtime instead of rebuilding it once an hour.
6. **Model discovery and connection tests go through the account.** For an OAuth
   row, `providers.listModels` reads the signed-in account's own model endpoint
   with `models.getAvailable` as fallback, the connection test proves the account
   by resolving auth, and the row's `apiStyle` follows the selected model, adding
   `openai_codex_responses` and `pi_messages`. The one-row-per-vendor assumption
   is amended by ADR 0098: every login now creates an independent row and
   credential scope.

## Consequences

- A subscriber signs in from Settings → Model configuration and needs no API
  credit for the supported vendors.
- The privilege boundary tightens: a vendor row now gives the sidecar a
  revocable hour-long token for its one bound provider, and no refresh token.
- Vendor logins depend on main answering `provider.resolveAuth`, so a restart
  mid-turn fails the request instead of signing with a stale token; API-key rows
  keep the same storage, payload, and resolve path.

## Alternatives

- Resolve the credential once at launch and put it in the payload — rejected:
  tokens expire mid-session, and refreshing would change the payload, miss
  `matches()`, and rebuild the runtime every turn.
- Give the sidecar the credential store and let pi-ai refresh in process —
  rejected: it hands the durable secret to the least trusted process and breaks
  the host-proxy allowlist.
