# ADR 0304: Trusted-extension provider and model access

- Status: Accepted for implementation
- Date: 2026-09-21
- Deciders: PI-Desktop core
- Related: ADR 0002, ADR 0134, ADR 0174 (D336), ADR 0258 (decision 4), spec 16
  §5 / §10.1 / §13, spec 03 §1, spec 12 §6.1, spec 13

## Context

`ExtensionAPIContext.modelRegistry` is documented as supported on the context
(spec 16 §5), but the runtime built it as a six-member object over the session
model plus plugin-registered agent models, and every other upstream member was
absent — calling one threw `TypeError: not a function`, which §5 forbids: an
unsupported member must exist, do nothing, return the documented neutral value,
emit one diagnostic per extension per member, and never throw.

Two capabilities were therefore missing. An extension could not discover a model
the user configured on a second endpoint, because `find` only saw the two-source
list, and `getProviderAuthStatus` reported "configured" for anything that merely
appeared in it. The registry also had no host-owned catalogue: `getAll` and
`getAvailable` returned models only for what the session already ran on.

ADR 0258 decision 4 and spec 16 §5 promise that the projection "exposes only
models and auth availability" with no additional grant. That promise is about
content, not about a permission. This record keeps the content promise, states
the inert-member rule, and adds the grant that the content requires.

## Decision

1. **Main owns the catalogue.** Electron main projects the ready host models —
   enabled provider rows whose auth is complete (`has_secret === true ||
   hasOauth === true || authKind === "none"`, the rule `listReadyPluginModels`
   already uses) — enriched with the models.dev metadata main already resolves
   for session launch, and hands them to extension Runners.
2. **The snapshot is Runner-scoped.** One fetch per Runner, then synchronous
   reads, because the upstream `getAll` / `getAvailable` / `find` /
   `getProviderAuthStatus` / `hasConfiguredAuth` members are synchronous.
   `refresh()` re-fetches and returns the upstream `{ aborted, errors }` result;
   it never throws. A failed or denied fetch leaves an empty snapshot, and the
   registry still answers with the session model and plugin-registered agent
   models, so an extension that only uses `registerAgent` keeps working. A
   plugin-owned provider keeps the answers it had before this change: its auth
   status reports configured with `source: "runtime"`, its display name is the
   plugin agent's name, and `hasConfiguredAuth` returns true for it.
3. **The projection carries `baseUrl` and capability metadata, never a
   credential.** `baseUrl` is not a secret: the renderer already renders it from
   `ProviderPublic.baseUrl`, and spec 16 §5's exclusion list names keys, secret
   references, OAuth tokens, arbitrary host headers, and host provider internals.
   `apiKey`, `headers`, secret references, and raw provider configuration are
   excluded. The sidecar derives pi's wire API from the row's api style and the
   model-level catalog pin, so pi's wire vocabulary stays inside the agent
   runtime instead of being copied into main.
4. **`getAll` projects the same ready set as `getAvailable`.** Upstream `getAll`
   semantics could not be verified from the shipped `.d.ts` files, whose runtime
   filtering is not observable, so PI does not invent a wider "known models" set.
   The divergence is recorded here rather than guessed at.
5. **Every unimplemented member exists and is inert** through the Runner's
   existing `inert()` helper: `getProvider`, `getError`, `isUsingOAuth`, the
   three credential accessors, `complete`, `stream`, `streamSimple`, and the
   registration family. Diagnostics are already deduplicated to one row per
   `(extension, kind, member)`, so repeated calls do not multiply them.
6. **The catalogue is gated by `models.list`**, evaluated in main from main-owned
   state — the session's loaded extension set, filtered by project activity —
   never from a wire-supplied identity: a session id main does not own is
   refused before any catalogue read, so a module cannot name another session's
   id to borrow its project grant. Without the grant the registry exposes no
   host models. When several plugins contribute extensions to one session the
   rule is the union of their grants, because their modules share one sidecar
   process (spec 16 §4.3); with one contributing plugin the check is exact.
7. **A new host-proxy method, `extensions.providers.list`,** carries the
   catalogue. It joins `HOST_PROXY_ALLOWED` (spec 16 §10.1) and is answered by
   the embedding host. Its wire params carry `sessionId` only: the subject comes
   from state main owns, and the capability is per-session rather than
   per-module.

## Consequences

- An extension can discover and describe every ready host model, including a
  model on a second endpoint, and read truthful auth availability without any
  credential. `modelRegistry` finally matches what spec 16 §5 claims.
- The gate is a real restriction. Without `models.list`, a plugin's extensions
  see only the session model and plugin-registered agent models. This tightens
  the "no additional grant" reading of ADR 0258 decision 4; spec 16 §5 is
  updated in the same change.
- The union-of-grants rule is a residual limit, not isolation. Modules sharing a
  session cannot be told apart at runtime, so a module can use a sibling
  plugin's grant. Per-extension isolation would need a separate process or
  module scope, which spec 16 §4.3 does not provide. The gate's practical force
  is install-time consent, per-call audit, and a per-plugin brake — not "an
  untrusted module cannot reach this".
- The snapshot is advisory and can be stale. Reads answer from the snapshot until
  the next extension load or an explicit `refresh()`. Provider or credential
  changes are not pushed into a running Runner; a stale row can only produce a
  rejected call, never a call against a different provider, model, or origin.
- `getAll` and `getAvailable` are identical in PI. An extension written for the
  pi CLI might expect `getAll` to include models whose providers are not yet
  configured.
- Requests against a chosen `(providerId, modelId)` are out of scope for this
  record. They land with their own high-risk grant, their own audit line, and
  their own decision record.
- No host-core RPC, database schema, setting, or plugin SDK contract changes.
  The plugin SDK type gains optional fields only.

## Alternatives

- **Keep the inline six-member registry.** Rejected: it violates spec 16 §5's
  inert rule, and neither `find` nor the auth status can be truthful without a
  host-owned catalogue.
- **Answer reads live, per call.** Rejected: the upstream read members are
  synchronous, and a per-call round trip would make `getAll()` unusable.
- **Reuse the session-launch resolver for the catalogue.** Rejected:
  `resolveAgentRuntimeLaunch` applies conversation-model policy and refuses the
  models that policy excludes, so the catalogue would be narrower than the
  user's own configuration.
- **Assemble the catalogue inside the sidecar from launch-payload data.**
  Rejected: it would duplicate main's readiness and models.dev enrichment rules,
  creating a second source of truth for "ready".
