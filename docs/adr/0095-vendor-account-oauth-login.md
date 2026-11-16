# ADR 0095: Sign in with a vendor account instead of pasting an API key

- Status: Accepted for implementation
- Date: 2026-08-18
- Deciders: PI-Desktop core
- Related: D237, D240, ADR 0098, D028, D031, ADR 0012, ADR 0020, ADR 0027

## Context

A provider row could only be authenticated one way: the user pastes an API key,
host-core encrypts it under `secret:provider:<id>:api_key`, and Electron main
reads the plaintext back on every launch so the sidecar can sign requests with a
constant `{ auth: { apiKey } }`. Users who already pay for a vendor subscription
— Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot — had to buy separate API
credit to use PI-Desktop at all.

## Decision

1. **The credential is a second secret on the same provider row.** OAuth
   credentials serialize to JSON and are stored through the existing encrypted
   secret store under `secret:provider:<id>:oauth`, beside — never instead of —
   `secret:provider:<id>:api_key`.

2. **Login orchestration lives in Electron main, in `oauth.ts`.** It implements
   `CredentialStore` over host-core's `secrets.*` RPC, serializing `modify` per
   provider so pi-ai's locked-refresh assumption holds, and bridges pi-ai's
   `AuthInteraction` to renderer events over five new invoke channels and one
   event channel under `pi-desktop/providers/oauth/*`.

3. **The vendor list is derived, not enumerated.** Cards come from
   `models.getProviders().filter(p => p.auth.oauth)`, so all seven vendors are
   supported on day one and a vendor that gains or loses a flow in pi-ai needs
   no change here.

4. **The sidecar resolves auth per request and never sees a refresh token.** An
   OAuth row's launch payload carries `apiKey: ""`.

5. **A vendor row's identity stays stable across turns.** `matches()` compares
   the provider row, whose `apiKey` is permanently `""`; a fresh `resolveAuth`
   closure per launch is a function property and disappears through
   `JSON.stringify`.

6. **Model discovery and connection tests go through the account.** For an OAuth
   row, `providers.listModels` reads the signed-in account's own model endpoint.
   pi-ai `models.getAvailable` (including the vendor's `filterModels`) is the
   fallback when that request fails.

## Consequences

- A subscriber signs in from Settings → Model configuration and picks models
  normally; no API credit is required for the seven supported vendors.
- The privilege boundary tightens rather than loosens.
- Vendor logins depend on main being alive to answer `provider.resolveAuth`; a
  host or main restart mid-turn fails the request rather than signing it with a
  stale token, which is the intended failure direction.
- API-key rows are untouched: same storage, same launch payload, same resolve
  path.

## Alternatives

- **Resolve the credential once at launch and put it in the payload.** Rejected:
  a Codex token expires in about an hour, so long sessions would break mid-turn;
  refreshing would change the payload and make `matches()` miss every turn,
  rebuilding the runtime and discarding warm state; and it would put a token the
  user never typed into a process that runs model-directed code.
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
- `apps/desktop/electron/main/oauth.ts`,
  `apps/desktop/electron/main/agent-sidecar.ts`
- `packages/agent-runtime/src/provider-binding.ts`
- `crates/host-core/src/secrets.rs`, `crates/host-core/src/providers.rs`
- Decision D237, D028, D031
