# Extension Provider and Model Access

A plan for two capabilities on the trusted agent-extension surface:

- **A. Information.** An extension can see the user's configured providers and
  models, and their auth availability.
- **B. Requests.** An extension can make a request against a chosen
  `(providerId, modelId)` with a caller-supplied path appended to that provider's
  `baseUrl` and a JSON, text, or `multipart/form-data` body, and the host supplies
  the credential.

- Status: Proposed (design review; no implementation in this change set)
- Baseline: `main` @ `43a373735` (v0.15.2; host protocol 11, schema 16)
- Branch: `feat/plugin-model-registry-api`
- Host protocol: unchanged. Host-core RPC: unchanged. Database schema: unchanged.
- Related: spec `07-plugins/16-trusted-extensions.md` (§5 support matrix, §10.1
  proxy allowlist, §12 phasing, §13 versioning),
  `07-plugins/12-plugin-ipc-and-host-services.md` (§5 naming, §6.1 declaration and
  audit rules, §8 budgets), `07-plugins/03-plugin-api.md` (§4 error model,
  §5 call auditing, §8 versioning), `07-plugins/13-plugin-permissions-matrix.md`,
  `07-plugins/02-plugin-manifest-schema.md` §5, `07-plugins/04-plugin-security.md`,
  `03-runtime/11-provider-model-system.md`, `03-runtime/14-secrets-storage.md`;
  ADR 0002, 0134, 0174 (D336), 0206, 0258 (D426), 0259
- Intent: this is an API extension, not a product feature. The host gains two
  members and stays protocol-agnostic; the flexibility lives on the plugin side,
  while every guard rail below is about consent, containment, and audit — not
  about which protocol a plugin speaks.
- Supersedes an earlier draft of this file that specified an image-generation API,
  a `tools.execute` authorization reuse, and support for
  `modelRegistry.complete`. Those are out of scope now: the request API below is
  protocol-agnostic, so an image plugin reaches `/images/generations` and
  `/images/edits` itself instead of the host growing one endpoint per protocol.

## 1. Problem

An agent extension runs inside the Agent sidecar
(`packages/agent-runtime`), where it receives the pi `ExtensionAPI` object. Two
things it needs are missing.

**Information.** `ExtensionAPIContext.modelRegistry` is documented as supported
(spec 16 §5, "Supported on context"), but the adapter exposes almost nothing:

- `packages/agent-runtime/src/runtime.ts:2434-2453` (`extensionModelRegistry()`)
  builds `getAll`, `getAvailable`, `find`, `getProviderDisplayName`,
  `getProviderAuthStatus`, and `hasConfiguredAuth` over exactly
  `[this.model, ...extensionRunner.getAgentModels()]` — the session's current
  model plus models registered in this same session by `registerAgent`.
  `find(providerId, modelId)` searches that two-source list, so no host provider
  model is ever found. Auth status is a hard-coded `{configured, source:
  "plugin"}` derived from those same ids.
- Every other upstream `ModelRegistry` member is absent from the object, so
  `ctx.modelRegistry.getProvider(...)` and the credential accessors throw
  `TypeError: not a function`. Spec 16 §5 requires an unsupported member to
  exist, do nothing, return the documented neutral value, emit one diagnostic per
  extension per member, and never throw (`runner.ts:727` passes
  `bridge.modelRegistry ?? {}` through with no inert wrapper).

**Requests.** There is no execution path at all. The upstream contract
(`@earendil-works/pi-coding-agent` 0.86.1, the version `packages/agent-runtime/package.json:28` pins; `dist/core/model-registry.d.ts:20-48`)
declares `complete(model, context, options)`, which the adapter does not
implement; and nothing on the surface can call a provider endpoint directly.

The consequence reported by the plugin author: inside a session, an extension can
only see and use the model the session is already running on. It cannot discover
`image2`, cannot resolve `(providerId, modelId)` for a second endpoint, and
cannot issue a request to it.

The sandboxed plugin surface is ahead here: plugins get `pi.models.list()`
(`models.list`) and `pi.agent.complete()` (`agent.complete`) through
`apps/desktop/electron/main/services/plugin-services.ts:286-411`, under the rule
from D336 / ADR 0174 that credentials never leave Electron main. The extension
surface has no equivalent, and `agent.complete` is text-only and tied to the
session's chat protocol, so it cannot reach a non-chat endpoint such as
`/images/generations`.

## 2. Goals and non-goals

Goals:

- **G1** `modelRegistry.getAvailable()` / `getAll()` return the user's ready host
  models, not only the session model.
- **G2** `modelRegistry.find(providerId, modelId)` resolves any ready host model,
  including one configured on a second endpoint.
- **G3** Auth availability in the registry is truthful, and carries no credential
  material of any kind.
- **G4** An extension can issue a request to a chosen provider and model, with a
  caller-supplied **path appended to that provider's `baseUrl`** and a JSON, text,
  or multipart body that may include local files it is allowed to read, and the
  host applies the credential.
- **G5** A caller cannot change the destination origin, escape the provider's
  base path, override the credential header, or read a credential.
- **G6** Existing behavior is preserved: plugin `models.list` / `agent.complete`
  are unchanged, existing extensions keep working, no host-core, protocol, or
  schema change.
- **G7** Every unsupported `ModelRegistry` member exists and is inert with one
  diagnostic, so the object finally matches spec 16 §5.

Non-goals:

- **N1** An image-generation API, an image capability flag, or any other
  protocol-specific endpoint baked into the host. The request API is generic
  (G4) and the plugin composes its own protocol on top of it.
- **N2** `modelRegistry.complete` / `stream`. The request API subsumes a chat
  call for a caller that wants one; see §10 for the follow-up option.
- **N3** Letting an extension hold a credential or reach a provider origin the
  host did not choose.
- **N4** Streamed or chunked request bodies, and streaming responses. Bodies are
  buffered and bounded; the host never proxies an unbounded stream. Multipart
  upload of local files is in scope (D3).
- **N5** OAuth-backed provider rows as request targets in v1 (see D5).
- **N6** `sessionManager` read/write, custom session entries, editor access, and
  the other v2/v3 items in spec 16 §12.
- **N7** Marketplace distribution of `agent.extension` plugins (spec 16 §2.5
  stays closed).
- **N8** A new host-core column, RPC, or `tools.execute` parameter.
- **N9** The sandboxed plugin surface. This plan is the trusted-extension
  surface; giving plugins a request API means a new `HOST_API_ALLOWLIST` entry, a
  `PluginHostServices` member, a `buildApi()` proxy, and the spec 12 §6.1
  obligations — a separate change (§13).

## 3. Current state and target

"Today" describes `runtime.ts:2434-2453` plus `runner.ts:727`. *Absent* means the
member is not on the object at all, so calling it throws.

| Member | Today | Target |
|---|---|---|
| `getAll` / `getAvailable` | session model + plugin-registered agent models | ready host catalogue + plugin-registered agent models, deduplicated by `provider/id` (D1, D2) |
| `find(providerId, modelId)` | same two-source list | same catalogue |
| `getProviderDisplayName` | plugin agent name, else the session provider name, else the raw `providerId` | catalogue truth; the raw-id fallback stays |
| `getProviderAuthStatus` | hard-coded `{configured, source: "plugin"}` | upstream `AuthStatus`, filled from the catalogue |
| `hasConfiguredAuth(model)` | same hard-coded test | catalogue truth, with host-core's `has_secret` semantics (D9) |
| `refresh(options?)` | absent; throws | supported: re-primes the catalogue snapshot |
| `getProvider` | absent; throws | stays inert (`undefined` + diagnostic) |
| `isUsingOAuth` | absent; throws | stays inert (`false` + diagnostic) |
| `getError` | absent; throws | stays inert (`undefined` + diagnostic) |
| `getApiKeyAndHeaders`, `getApiKeyForProvider`, `getProviderAuth` | absent; throws | inert with the documented neutral value plus one diagnostic each (G5) |
| `complete` | absent; throws | stays inert in this scope (N2, §10) |
| `stream`, `streamSimple` | absent; throws | stay inert in this scope (N2, §10) |
| `registerProvider` / `unregisterProvider` on `pi` | plugin-owned alias over `registerAgent` (`extensions/runner.ts:853-915`) | unchanged |
| `registerProvider`, `unregisterProvider`, `getRegistered*` on `modelRegistry` | absent; throws | inert with the documented neutral value plus one diagnostic each (D9) |
| `ctx.providers.request(...)` | n/a — does not exist | new PI-specific member (D3) |

`getProvider` and `isUsingOAuth` stay inert deliberately: nothing in G1-G7 needs
a provider object or OAuth introspection, and both widen the surface with no
consumer.

## 4. Design decisions

### D1. Keep the upstream shape for the information surface

`modelRegistry` keeps the pi `ModelRegistry` member set, because an extension
written for the pi CLI must remain the module a plugin contributes (spec 16 §1,
ADR 0002).

Upstream `Model<TApi>` requires `id`, `name`, `api`, `provider`, `baseUrl`,
`reasoning`, `input`, `cost`, `contextWindow`, `maxTokens`
(`@earendil-works/pi-ai`, `dist/types.d.ts:716-745`). A descriptor that omitted
`baseUrl` would not be a `Model<Api>`, and the declared
`getAll(): Model<Api>[]` could only be satisfied with a cast, which root
`AGENTS.md` §11 forbids. So the catalogue projects real `Model<Api>` values:

- `baseUrl` included. It is not a secret: the renderer already renders it from
  `ProviderPublic.baseUrl`, and spec 16 §5's exclusion list names keys, secret
  references, OAuth tokens, arbitrary host headers, and host provider internals
  — `baseUrl` is not among them. Calling that a spec requirement would overstate
  it; it is a PI decision recorded here.
- `apiKey` and `headers` absent. This is the security boundary.
- `reasoning`, `input`, `cost`, `contextWindow`, `maxTokens` filled from the same
  models.dev-derived projection the renderer uses (ADR 0134), with documented
  neutral defaults where metadata is missing. They are metadata, not billing
  truth.

Rejected: passing every provider config (with keys) into the sidecar so `pi-ai`
could call providers directly. That would put all provider credentials in the
process that also runs plugin-supplied TypeScript and holds bash, contradicting
ADR 0174 / D336. The sidecar receives only the launched provider's config today,
and that stays true.

Rejected: a PI-only `modelRegistry.list()` without `Model` objects. Smaller
surface, but it breaks portability for exactly the members pi defines.

### D2. Main owns the catalogue; the sidecar holds a Runner-scoped snapshot

Upstream reads are synchronous (`getAll(): Model<Api>[]`,
`model-registry.d.ts:26-28`), so the sidecar cannot fetch on read:

- Main owns the catalogue and all credential state.
- The sidecar holds a snapshot as **Runner-instance state**, primed at Runner
  creation and replaced atomically on `refresh()`. A failed refresh keeps the
  previous snapshot and records one diagnostic; it never empties the registry.
- The new module holds **no module-level state**. jiti caches modules and module
  instances are shared across Runners (spec 16 §4.3), so module-scoped counters
  or caches would leak between sessions.
- Provider or credential changes appear no later than the next extension load or
  an explicit `refresh()`; they are not pushed into running Runners.
- The snapshot is advisory. `request` re-resolves `(providerId, modelId)` against
  live state, so a stale snapshot can only produce a rejected call, never a call
  against a different provider, model, or origin.

Projection source in main: provider rows and credential flags from host-core
(`providers.list`, `includeDisabled: false`) merged with the models.dev-derived
`ModelConfig` already used by `createProviderCatalogRuntime`
(`apps/desktop/electron/main/runtime/provider-catalog.ts`) and
`session-launch.ts`. Readiness mirrors `listReadyPluginModels`
(`apps/desktop/electron/main/plugin-agent-complete.ts:51-58`):
`enabled !== false && (hasSecret || hasOauth || authKind === "none")`. That
matches upstream's documented `getAvailable`, which returns the models "whose
providers have complete auth configuration" (`pi-ai`, `dist/models.d.ts:122-123`).

Upstream `getAll` semantics could not be verified — the package ships `.d.ts`
files here and its runtime filtering is not observable — so PI projects the same
ready set into both members. That divergence is a decision for the ADR, not an
accident: an extension written for pi might expect `getAll` to include models
whose providers are not yet configured.

The catalogue is **not** filtered by the conversation-model policy that session
launch applies (`session-launch.ts:330`). That policy picks the session's chat
model and applies to session launch and the pickers; it must not restrict what an
extension may see or target, or the reported use case becomes unreachable (D4).

### D3. One execution member: a protocol-agnostic provider request

The execution surface is a PI-specific member, not a pi `ModelRegistry` member,
because it is not part of the upstream contract:

```ts
ctx.providers.request(input): Promise<ProviderRequestResult>
```

It is deliberately **not** a completion API. The caller supplies the path, so the
same member reaches `/chat/completions`, `/images/generations`, `/embeddings`,
`/models`, or any other path the provider exposes. The host contributes exactly
three things and nothing protocol-specific: the destination origin, the
credential, and the transport policy (D4-D6). It assembles the envelope the
caller asked for — a JSON serialization or a `multipart/form-data` body — but
never interprets it, does not know about streaming, and does not map provider
responses into PI types.

Why this shape rather than `complete`:

- The requested capability is "call another provider/model", not "get a chat
  completion". Baking one protocol in would repeat the mistake the earlier draft
  made by adding an image endpoint.
- A generic request has no response-mapping fidelity problem: there is no
  `AssistantMessage` to synthesize, no `stopReason` to invent, and no usage to
  translate. The caller receives what the provider sent.
- It keeps the host surface small and stable while plugins evolve their own
  protocol handling — the design principle in spec 03 §1.

`modelId` is optional but recommended, because it selects model-specific provider
detail. It is not injected into the request body: a caller that wants the
provider's `model` field sends it. The host does not silently add, rewrite, or
remove body fields.

`providerId` is **required**. Unlike `modelId` it has no default: the caller names
the provider on every call, so a request cannot silently land on a provider the
caller never named.

#### Body shapes

`body` is a discriminated union, so the host never guesses and a caller never has
to hand-encode a transport format:

| `body.kind` | Host behaviour | `content-type` |
|---|---|---|
| `json` | `JSON.stringify(value)` | `application/json` |
| `text` | verbatim | `body.contentType` or `text/plain` |
| `base64` | decoded to bytes | `body.contentType` or `application/octet-stream` |
| `multipart` | assembled from `fields` and `files`; the boundary is generated by the transport | `multipart/form-data; boundary=…` |

`multipart.fields` are text parts (`name`, `value`); `multipart.files` are file
parts (`name`, `path`, optional `filename`, optional `contentType`). That is the
shape an OpenAI Images edit needs: `fields` for `model`, `prompt`, and `n`, plus
one `files` entry named `image` — or several named `image[]`.

Rules:

- **The host owns `content-type`.** A caller-supplied `content-type` header is
  refused (D5), because for multipart the boundary must match the body the host
  built. A caller that needs a specific type sets `body.contentType` instead.
- **No content sniffing.** The host does not inspect a file to decide its type;
  an unspecified `contentType` becomes `application/octet-stream`. Type
  correctness is the caller's business, which also keeps the host free of
  protocol knowledge.
- **Part metadata is validated**: `name` and `value` are bounded and free of
  control characters, and `filename` carries no path separator. Anything else is
  `INVALID_ARGUMENT`.
- **A body on `GET` is refused.** Every other method accepts any body kind; the
  host does not police protocol semantics.
- **Bodies are bounded** (D8).

#### Which local files may be uploaded

A `multipart.files` entry names a path; the host reads it, and only from roots the
session owns:

- The session's project root(s), the session's scratch directory, and the
  attachment store (`<dataDir>/attachments`). Roots are captured by the host,
  never supplied by the caller.
- Resolution is symlink-aware: the candidate is `realpath`'d, each root is
  `realpath`'d, and the resolved file must sit strictly inside one of them. `..`,
  absolute escapes, and an `attachments/<sha256>` reference that resolves outside
  the store are all refused.
- The read is bounded and re-checked against the cap, so a file that grows after
  `stat` cannot overrun it.
- Host-internal paths stay unreadable: the data directory holding provider keys
  and the session store is not among the allowed roots.

This is the containment the shipped image-edit input loader already applies
(`apps/desktop/electron/main/services/image-inputs.ts:6-88` — realpath against
project/scratch/attachments, 16 MiB per file, 32 MiB per set, 64 MiB loader
budget). The plan extracts that containment and bounded read into a shared
helper, keeping the image-specific signature sniffing on the image path, rather
than writing a second containment rule set (root `AGENTS.md` §6: one rule, one
place).

Honest framing: for a plugin that already holds `agent.extension`, reading these
files is not a new capability — its modules run in the sidecar with bash. The
containment exists so the request API does not become a general "read any host
file and send it to a provider" primitive, and so the request handler's blast
radius stays equal to the shipped image path's. It bounds what the host will
resolve on the caller's behalf — not what a caller that can already read files
chooses to send as `base64` bytes.

### D4. Path joining: append-only, prefix-preserving, validated in main

This is the security core of the feature, and it is enforced in main, never in
the sidecar or the extension.

Rules:

1. **Origin is fixed.** The final URL's scheme, host, and port come from the
   provider row's `baseUrl`. The caller's path cannot introduce a scheme, an
   authority, or a different host.
2. **The result stays inside the base path.** After joining and normalization,
   the final pathname must still be the base pathname plus the caller's segments.
3. **Only the path is caller-controlled.** Method, headers, and body are bounded
   (D5, D6); the destination is not.

Accepted and rejected forms, for a base `https://api.example.com/v1`:

| Caller `path` | Result | Why |
|---|---|---|
| `/images/generations` | `https://api.example.com/v1/images/generations` | appended |
| `images/generations` | `https://api.example.com/v1/images/generations` | leading slashes normalized to one |
| `chat/completions?x=1` | `https://api.example.com/v1/chat/completions?x=1` | a query string is part of the path |
| `/` | `https://api.example.com/v1/` | base itself |
| `https://evil.example/x` | rejected `INVALID_ARGUMENT` | absolute URL |
| `//evil.example/x` | rejected | scheme-relative |
| `/../admin` | rejected | escapes the base path |
| `/%2e%2e/admin` | rejected | traversal after decoding |
| `/a\..\b` | rejected | backslash and traversal |
| `/x#frag` | rejected | fragment |
| `" "` / `"/a\nb"` | rejected | empty, control characters |
| a 4 KiB path | rejected | over the length cap |

Algorithm, in this order — the order matters, because `new URL` resolves `..`
before anything can inspect it:

1. Parse `baseUrl`; require `http:` or `https:`, and reject embedded credentials,
   a query, or a fragment. The row was validated at write time by host-core
   (`crates/host-core/src/providers/validation.rs`); this is a defensive re-check,
   not the primary gate.
2. Validate the caller string **before** any URL construction: non-empty, ≤ 2048
   bytes, no `\`, no `#`, no CR/LF/NUL or other control characters, not starting
   with `//`. Split off the query, percent-decode the path part (bounded to two
   passes, the second tolerant of a `%` the first one produced), and reject if
   any `..` segment appears in the decoded form. The query is the caller's own
   data and is passed through untouched: a `..` or a bare `%` in it neither
   escapes the base prefix nor refuses the call.
3. Compose: `pathname = base.pathname.replace(/\/+$/, "") + "/" +
   callerPath.replace(/^\/+/, "")`, then set `search` from the caller's query if
   present.
4. Normalize, then assert the final `origin` equals the base origin **and** the
   decoded final pathname starts with the decoded base pathname. Reject
   otherwise. This second check is the belt-and-braces layer: it catches any
   encoding that survived step 2, because such a path would resolve out of the
   base prefix. Both sides are decoded because the URL parser percent-encodes
   either of them, and a decoded pathname measured against a raw base path would
   refuse every call to `https://host/v1%20beta`.

No implicit `/v1`. The provider row's `baseUrl` is used as configured and the
caller's path is appended to it, exactly as specified. A caller that needs `/v1`
passes it.

The final URL, without its query, is the audit anchor (D10).

### D5. Credentials and headers are host-owned

The host resolves and applies credentials; the caller never sees them and cannot
override them.

- Resolution reuses the established main-side provider path:
  `providers.get` (row: `enabled`, `baseUrl`, `headers`, `authKind`, `models`)
  and `providers.getSecret` → secret, exactly as
  `apps/desktop/electron/main/services/image-generation-service.ts:43-70` does.
- The row must exist, be `enabled`, have a `baseUrl`, and list the requested
  model in `models[]` when `modelId` is given. `authKind === "none"` needs no
  secret; `apiKey` needs one; `oauth` is rejected in v1 (below).
- Header composition: the provider row's configured `headers` first, then the
  caller's headers merged through `normalizeProviderHeaders` /
  `mergeProviderHeaders` (`packages/agent-runtime/src/provider-headers.ts:78-146`,
  which enforces the existing caps: ≤ 32 headers, key ≤ 256 B, value ≤ 4096 B),
  and finally the host sets the credential header **last**, so it always wins.
- Caller headers are refused for a denylist: `authorization`, `cookie`,
  `set-cookie`, `host`, `content-length`, `content-type`, `connection`,
  `transfer-encoding`, `upgrade`, `proxy-authorization`, and anything starting
  with `x-forwarded-`.
  CR/LF in any key or value is refused. The denylist exists so a caller cannot
  forge, strip, or redirect the credential, or corrupt the transport framing.
- `authKind === "oauth"` is rejected with `PROVIDER_AUTH_UNSUPPORTED` in v1, the
  same exclusion spec 21 applies to image generation. Two reasons: for a vendor
  account the wire endpoint is model-dependent (`vendorOAuth.bindingFor(provider.id,
  modelId)`), so `baseUrl` alone does not identify the destination; and the
  access token is short-lived and resolved through a per-call auth handle. Making
  that work means turning this API into an OAuth proxy, which is a decision, not
  a detail (§10).

**Which resolver not to use.** The session-launch resolver must not be reused
here. `resolveAgentRuntimeLaunch` applies conversation-model policy
(`session-launch.ts:330`) and refuses the models that policy excludes, which is
exactly the kind of target this feature exists to reach. The request handler
therefore resolves the provider row and model binding directly, and deliberately
applies no conversation-model policy: any model the provider row binds is a
legitimate request target.

### D6. Response contract: status is a result, failures are errors

- An HTTP response — including 4xx and 5xx — is a **result**, not a host error.
  The caller owns the protocol semantics, so translating a provider's 404 or 400
  into a PI error code would destroy information. The result carries `status`,
  `statusText`, `ok`, `contentType`, response headers, and the body.
- Host-side failures do throw, with a code (D10, §5.4): the path was rejected,
  the provider or model is not usable, the credential is missing, the transport
  failed, the budget expired, or the response exceeded the cap.
- Redirects are **not followed**: the request sets `redirect: "manual"`, and a 3xx
  is returned as a result with its `status` and `location`. The credential must
  never be re-sent to a host the provider row did not name, and the caller can
  decide what to do. This mirrors spec 21's reject-redirects posture.
- **No automatic retry, ever**, on this path. The host cannot know whether a
  request is idempotent — a POST to `/images/generations` bills per call — so
  retrying is the caller's decision. When the provider sends `Retry-After`, the
  result carries `retryAfterMs` so the caller can pace itself. This deliberately
  differs from the one-shot completion path, which retries under ADR 0206 because
  its requests are host-owned and non-billing-by-construction.
- The response body is returned decoded by shape: `json` when the content type is
  JSON and parsing succeeds, `text` for textual types, `base64` otherwise, with
  the byte length. Bodies are rejected above the cap rather than truncated, so
  nothing is silently lossy (the convention spec 21 sets for oversized input).
- `set-cookie` is stripped from the returned headers.
- The request's own credential header is never echoed in the result or in an
  error, even when the provider reflects it.

### D7. Grants: `models.list` for information, a new `provider.request` for requests

An extension runs only when its owning plugin holds `agent.extension`. That grant
buys the trust level of the sidecar (spec 16 §2), not the user's provider
credentials, so the two new capabilities are gated per owning plugin:

| Capability | Grant |
|---|---|
| host catalogue in `getAvailable` / `getAll` / `find`, truthful auth status | `models.list` |
| `ctx.providers.request` | `provider.request` (new) |

`provider.request` needs its own grant rather than riding on `agent.complete` or
`agent.extension`: it reaches the **whole** provider API surface with the user's
credential — any path, any method — including endpoints that spend money
(generations, batches) and endpoints that read or delete account resources. No
existing permission covers that. It is classified high risk, shown at install
time, and audited per call.

**How the subject is resolved.** Not from the wire. `extensionId` on a call is
unverified input, and all modules of a session share one sidecar process that
also holds bash (spec 16 §2.2), so a module could claim another extension's id or
call the proxy directly. Main therefore derives the subject from state it owns:

1. `agentExtensions: Map<id, {id, pluginId, pluginName, entry, root}>`, populated
   only for plugins granted `agent.extension`; ungranted declarations are skipped
   and audited as `plugin.agentExtensions.skipped`
   (`plugin-runtime.ts:3104-3137`).
2. The session's extension set is the projection main itself sent at launch:
   `plugins.getAgentExtensions().filter(pluginActiveInProject(...))`
   (`session-launch.ts:670-679`).
3. The handler maps the claimed `extensionId` through that map. An id outside the
   session's set is rejected; the claimed id is used for audit attribution only.

**Residual limit, stated plainly.** Two plugins contributing extensions to the
same session cannot be told apart at runtime, because their modules share one
process. The rule is therefore the **union of the grants of the plugins whose
extensions are loaded in that session**, evaluated at call time from the live
plugin registry. With one contributing plugin — the common case — the check is
exact; with several, a module can use a sibling's grant. Per-extension isolation
would need a separate process or module scope, which spec 16 §4.3 does not
provide. The gate's real force is that the user sees and confirms the grant at
install time and every call is audited and rate-braked — not "an untrusted module
cannot reach this".

Without the catalogue grant, the registry still answers with plugin-registered
agent models and the session model. Without the request grant, calls reject with
`PERMISSION_DENIED` and an audit line. An extension that only uses
`registerAgent` keeps working on `agent.extension` alone (G6).

**Reconciliation with recorded decisions.** ADR 0258 decision 4 and spec 16
§5:282 promise that the projection "exposes only models and auth availability"
with no additional grant. Adding the `models.list` gate *tightens* that recorded
promise, and spec 16 §13 requires a new member to land inert with a diagnostic
until a decision moves it. Both must be updated by the ADR that accompanies the
stage, not afterwards (§9).

### D8. Budgets, brakes, cancellation

| Control | Value | Basis |
|---|---|---|
| Rate | 8 requests / rolling 60 s per plugin, one counter shared with the plugin host's `agent.complete` brake (`plugin-runtime.ts:678-681`, `:3944-3953`), charged once the request is about to be dispatched | same plugin, same kind of spend; a separate counter would let a plugin alternate surfaces for 8 + 8, and a call refused before it left the host spends nothing |
| In-flight | 4 per plugin | bounds a fan-out without serializing normal use |
| Per-call budget | 60 s default, `timeoutMs` up to 300 s, measured from the moment main accepts the call, pre-flight included | a provider call is bounded; the caller may ask for more, and a budget that covered only the fetch would let provider resolution and an upload run unbounded |
| Transport deadline | budget + 15 s slack, passed explicitly | `rpcTimeoutMs` defaults to 130 s and cannot know the caller's budget (`packages/shared/src/rpc-timeouts.ts:54-56`), and `ParentHostProxy.call` takes an override (`parent-host-proxy.ts:93-99`) |
| Request body, non-multipart | ≤ 1 MiB | JSON, text, or base64 payloads |
| Multipart body | ≤ 8 files, ≤ 32 MiB per file, ≤ 64 MiB total | mirrors the shipped image-edit tiers (`image-inputs.ts:48-82`, 16 MiB/file and 32 MiB/set) at one step larger, because this API is not image-only |
| Response body | ≤ 4 MiB | rejected above, never truncated |
| Path | ≤ 2048 bytes | D4 |
| Headers | existing provider-header caps | `provider-headers.ts:16-18` |

Cancellation is explicit and bidirectional:

- The caller may pass `signal`. The sidecar mints a `callId`, sends it with the
  request, and on abort sends `extensions.providers.abort` for that id.
- Main registers an `AbortController` keyed by `(sessionId, callId)`, aborts the
  fetch, and clears the entry when the call settles — including on failure, so
  nothing leaks.
- Runtime disposal and session switch abort every outstanding call for that
  session; the handler must hook the sidecar's disposal path, because
  `tools.abort` only reaches controllers registered by the local-tool path
  (`packages/host-runtime/src/agent-sidecar.ts:268-271`).
- A call that outlives its Runner is aborted; its result is discarded rather than
  delivered to a session whose runtime was replaced.

### D9. What stays inert

`getApiKeyAndHeaders`, `getApiKeyForProvider`, and `getProviderAuth` return the
documented neutral value with one diagnostic per extension per member, as spec 16
§5 requires. PI-Desktop never hands a key to an extension; a caller that needs a
provider call uses `ctx.providers.request`.

`getProvider`, `isUsingOAuth`, `getError`, `complete`, `stream`, `streamSimple`,
and the `modelRegistry` registration family (`registerProvider`,
`unregisterProvider`, `getRegisteredProviderConfig`,
`getRegisteredNativeProvider`, `getRegisteredProviderIds`) are inert in this
scope. The difference from today is that they **exist** and are inert instead of
throwing (G7).

This reuses the helper the Runner already has for exactly this purpose
(`Runner.inert`, `extensions/runner.ts:623-635`, applied to `INERT_UI_MEMBERS` at
`:124` and `:707-708`): the member exists, reports one diagnostic per extension
per member, returns the documented neutral value, and never throws.

`hasConfiguredAuth` uses host-core's semantics: `has_secret = has_api_key ||
has_oauth` (`crates/host-core/src/providers/repository.rs:23`). `hasSecret: true`
therefore does not mean an API key exists, so the projection carries `hasOauth`
and `authKind` alongside it and an extension is not misled about which providers
the request API can actually target in v1.

### D10. Follow the repository's host-service authoring rules

The extension bridge is a second host-service surface next to the plugin broker,
so it follows the same documented conventions instead of inventing its own:

- **Declaration and audit naming.** Spec 12 §6.1 requires each new capability to
  be declared in that surface's allowlist with its own audit-operation names. The
  three methods join `HOST_PROXY_ALLOWED`
  (`packages/host-runtime/src/agent-sidecar.ts:51-79`), each with a distinct
  audit operation, mirroring that spec's chain: group, gate, execute, audit,
  answer.
- **Errors carry a code.** Spec 03 §4 requires every failure to carry a `code`;
  §5.4 lists them.
- **Audit fields.** Spec 03 §5 fixes the field set for a logged call. Each request
  logs `extensionId`, owning `pluginId`, `sessionId`, `providerId`, `modelId`,
  `method`, the final **path without its query**, `status`, response bytes,
  `durationMs`, and `ok` / `errorCode`. Never the body, never the query string
  (it can carry a secret), never the credential.
- **Module size.** `scripts/check-architecture.mjs` enforces a **800 LOC ceiling
  on new TS/TSX modules** (plus per-path limits for the main index and the app
  store, and 1000 for Rust), so the catalogue projection, the request client, and
  the main-side request handler are separate modules.

## 5. Interfaces

### 5.1 Extension-visible

`packages/agent-runtime/src/extensions/runner.ts:191-223` declares
`modelRegistry?: unknown`. It becomes typed, and the context gains one PI-specific
sibling (`runner.ts:727` wiring):

```ts
modelRegistry?: ExtensionModelRegistry   // pi member set, was unknown; the inert remainder is enumerated in §3
providers?: ExtensionProviderAccess      // PI-specific, new

interface ExtensionModelRegistry {
  getAll(): Model<Api>[]
  getAvailable(): Model<Api>[]
  find(providerId: string, modelId: string): Model<Api> | undefined
  complete<TApi extends Api>(model: Model<TApi>, context: Context,
    options?: ModelsApiStreamOptions<TApi>): Promise<AssistantMessage>   // inert in this scope
  stream<TApi extends Api>(model: Model<TApi>, context: Context,
    options?: ModelsApiStreamOptions<TApi>): AssistantMessageEventStream   // inert in this scope
  streamSimple(model: Model<Api>, context: Context,
    options?: ModelsSimpleStreamOptions): AssistantMessageEventStream      // inert in this scope
  getProviderDisplayName(providerId: string): string
  getProviderAuthStatus(providerId: string): AuthStatus
  hasConfiguredAuth(model: Model<Api>): boolean
  refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>
}

interface ExtensionProviderAccess {
  request(input: ProviderRequestInput): Promise<ProviderRequestResult>
}

type ProviderRequestInput = {
  providerId: string
  /** Recommended: selects model-specific provider detail. Not injected into the body. */
  modelId?: string
  /** Appended to the provider's baseUrl. Validated per D4. */
  path: string
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
  headers?: Record<string, string>
  body?: ProviderRequestBody
  /** Default 60_000, maximum 300_000. */
  timeoutMs?: number
  signal?: AbortSignal
}


type ProviderRequestBody =
  /** JSON, serialized by the host; content-type: application/json. */
  | { kind: "json"; value: unknown }
  /** Opaque text. */
  | { kind: "text"; value: string; contentType?: string }
  /** Small binary payload, base64-encoded by the caller. */
  | { kind: "base64"; value: string; contentType?: string }
  /** multipart/form-data; the host generates the boundary. */
  | {
      kind: "multipart"
      fields?: Array<{ name: string; value: string }>
      files?: Array<{ name: string; path: string; filename?: string; contentType?: string }>
    }
type ProviderRequestResult = {
  status: number
  statusText?: string
  ok: boolean
  contentType?: string
  headers: Record<string, string>
  body: { kind: "json" | "text" | "base64"; value: unknown; bytes: number }
  location?: string
  retryAfterMs?: number
  durationMs: number
}
```

Signatures in `ExtensionModelRegistry` match upstream exactly so a pi CLI
extension type-checks against the object. `AuthStatus` is `{configured: boolean;
source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" |
"models_json_command"; label?: string}`
(`pi-coding-agent/dist/core/provider-composer.d.ts:42-46`);
`ModelsRefreshOptions` / `ModelsRefreshResult` are `{allowNetwork?, providers?,
force?, signal?}` and `{aborted: boolean; errors: ReadonlyMap<string, Error>}`
(`pi-ai/dist/models.d.ts:29-40`). PI-specific credential detail belongs on the
catalogue rows, not in an upstream-typed return value.

### 5.2 Sidecar to main methods

Registered in `HOST_PROXY_ALLOWED` and `TrustedExtensionSidecarBridge`
(`packages/host-runtime/src/agent-sidecar.ts:51-79`, `:82-90`, dispatch at
`:520-534`), implemented in
`apps/desktop/electron/main/runtime/sidecar.ts:345`:

| Method | Params | Result |
|---|---|---|
| `extensions.providers.list` | `{ sessionId }` | `{ models: HostModelDescriptor[] }` |
| `extensions.providers.request` | `{ sessionId, extensionId, callId, providerId, modelId?, path, method, headers?, body?, timeoutMs? }` | `ProviderRequestResult` |
| `extensions.providers.abort` | `{ sessionId, callId }` | `{ ok: boolean }` |

`HostModelDescriptor` is the redacted catalogue row, and the material the sidecar
needs to build a `Model<Api>` — including `baseUrl`, excluding `apiKey`, headers,
secret references, and raw provider `config_json`:

```ts
type HostModelDescriptor = {
  providerId: string
  providerName: string
  modelId: string
  label: string
  alias?: string
  /** Stored provider api style; the sidecar resolves pi's wire API from this. */
  apiStyle?: string
  /** models.dev wire API pinned for the model; wins over `apiStyle`. */
  modelApi?: string
  baseUrl: string           // not a secret; required by Model<Api>
  isDefault?: boolean
  supportsReasoning: boolean
  supportsImages: boolean   // image input
  hasSecret: boolean        // host-core semantics: API key OR OAuth
  hasOauth: boolean
  authKind: string
  toolCall: boolean
  thinkingLevels: string[]
  contextWindow?: number
  maxTokens?: number
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  modalities?: { input: string[]; output: string[] }
}
```

The descriptor carries the provider's stored api style and the model-level catalog
pin rather than a resolved wire API, so pi's wire vocabulary stays inside the
agent runtime: the sidecar resolves it with the same helper session launch uses.
The list method carries `sessionId` alone, because main derives the subject from
state it owns (D7); the request method carries `extensionId` for audit
attribution only.

### 5.3 Path grammar

Normative, and the acceptance tests follow this table (D4): origin fixed by the
provider row; appended segments only; no scheme, authority, `..`, backslash,
fragment, or control characters; query allowed; ≤ 2048 bytes; the final pathname
must stay inside the base pathname.

### 5.4 Error codes

Host failures, each carrying a `code`:

| Code | When |
|---|---|
| `PERMISSION_DENIED` | grant missing, or `extensionId` outside the session's loaded set |
| `INVALID_ARGUMENT` | path rejected by §5.3, a missing or empty `providerId`, bad method or body shape, oversized body or header, control characters or a path separator in a multipart part, unknown `timeoutMs` |
| `PROVIDER_NOT_FOUND` | no such provider row, or it is disabled |
| `MODEL_NOT_CONFIGURED` | `modelId` is not a binding of that provider |
| `PROVIDER_AUTH_MISSING` | the row needs a secret and none is stored |
| `PROVIDER_AUTH_UNSUPPORTED` | `authKind === "oauth"` in v1 (D5) |
| `NETWORK_ERROR` | transport failure, DNS, TLS, refused connection |
| `TIMEOUT` | the per-call budget expired |
| `ABORTED` | the caller, the runtime, or session teardown cancelled the call |
| `RESPONSE_TOO_LARGE` | the response exceeded the cap; carries `status` and `bytes` |
| `RATE_LIMITED` | the per-plugin brake |
| `UNSUPPORTED` | feature not wired in this host (for example a headless host without an HTTP transport) |
| `FILE_NOT_FOUND` | a `multipart.files` path does not exist or is not a regular file |
| `FILE_OUTSIDE_ALLOWED_ROOTS` | a `multipart.files` path resolves outside the project, scratch, and attachment roots |
| `FILE_TOO_LARGE` | one uploaded file exceeds its per-file cap |
| `UPLOAD_TOO_LARGE` | the multipart payload exceeds its total cap |

HTTP 4xx/5xx are results, not codes (D6). A rejected file path, cap, or part shape
throws instead, because the request never left the host.

## 6. Change surface

| Area | File | Change |
|---|---|---|
| Sidecar access module | `packages/agent-runtime/src/extensions/provider-access.ts` (new) | catalogue snapshot (Runner-scoped, no module state), descriptor projection, inert members, request client, path helper |
| Sidecar wiring | `packages/agent-runtime/src/runtime.ts:2434-2453`, `:2458-2465` | replace the inline registry with the new module; add the `providers` member |
| Bridge types | `packages/agent-runtime/src/extensions/runner.ts:191-223`, `:727`, `index.ts`, `types.ts` | typed `modelRegistry`, `providers`, `extensionId` on bridge calls |
| Host proxy | `packages/host-runtime/src/agent-sidecar.ts:51-79`, `:82-90`, `:520-534` | three new allowlisted methods, bridge type members, dispatch cases |
| Main bridge | `apps/desktop/electron/main/runtime/sidecar.ts:345` | implement the three handlers: subject resolution (D7), catalogue re-validation, audit lines, abort registry |
| Request handler | new module in `apps/desktop/electron/main` | path validation (D4), provider-row resolution incl. `providers.getSecret` (D5), header composition, body assembly incl. multipart (D3), redirects off, caps, no retry |
| Shared file reader | `apps/desktop/electron/main/services/image-inputs.ts:6-88` | extract the realpath containment and bounded read into a reusable helper; the image path keeps its signature sniffing and passes its existing caps |
| Catalogue projection | new module beside `plugin-agent-complete.ts` | ready-model projection with `baseUrl`, capability fields, and redaction; `PluginModelInfo` gains optional fields |
| Transport deadline | `packages/shared/src/rpc-timeouts.ts:54-56` | an entry or call-site override for the request method's deadline (D8) |
| SDK types | `packages/plugin-sdk/src/index.ts:703-717` | additive optional fields on `PluginModelInfo` |
| Permission registration | `packages/plugin-sdk/src/index.ts:1258-1305` (`PLUGIN_PERMISSIONS`), `docs/spec/07-plugins/02-plugin-manifest-schema.md:314-354` (§5 enum, authoritative: an unknown permission fails validation), `apps/desktop/src/features/plugins/model.ts:39-82` (`PERMISSION_RISK`), `packages/plugin-devkit/src/check.ts:27-47` (`HIGH_RISK_PERMISSIONS`) and its `PERMISSION_API_HINTS` | declare `provider.request` in every copy |
| i18n | `packages/i18n/src/locales/*/index.ts` | permission label and description in every locale |
| Devkit and docs | `packages/plugin-devkit`, `docs/plugin-development.md` | publish the new members |

Three synchronization obligations, two of them pre-existing defects this change
must not silently inherit:

- The permission enum is duplicated four times, and spec
  `07-plugins/02-plugin-manifest-schema.md:314-354` is the authoritative copy
  ("unknown permission = validation failure"). It currently **omits**
  `models.list`, `agent.complete`, `agent.extension`, `session.read`, and
  `ui.settings`, all of which are in `PLUGIN_PERMISSIONS` — so the SDK already
  accepts manifests the manifest spec calls invalid. Adding `provider.request`
  must update this copy too: S3 added `provider.request` and closed the gap, so
  the enum now matches `PLUGIN_PERMISSIONS` member for member.
- `packages/plugin-devkit/src/check.ts` claims in its comment to mirror
  `PERMISSION_RISK`, but omitted `fs.write.workspace`, `fs.delete.workspace`,
  `agent.complete`, `agent.extension`, `desktop.control`, `session.read`,
  `mcp.server.local`, `mcp.server.remote`, and `background.service`, which
  `apps/desktop/src/features/plugins/model.ts` marks high. S3 added
  `provider.request` and the missing names to both copies, so the list equals
  the renderer's explicit high tier.
- Root `AGENTS.md:106` routes plugin work to `packages/plugin-sdk/AGENTS.md` and
  the package README; neither exists. The scoped rules here come from root
  `AGENTS.md`, spec 07, and the existing tests — a documentation gap to report,
  not something to invent.

`runtime.ts` is a listed hotspot (root `AGENTS.md` §7), so the new code lives in
its own module and `runtime.ts` gains wiring only. The one refactor this scope
needs is the contained-file reader extraction above: duplicating that containment
would create a second source of truth for a security rule. `image-inputs.ts`
behavior is preserved — the image path keeps its 16 MiB per file, 32 MiB per set,
64 MiB budget, and PNG/JPEG/WebP sniffing; the shared helper takes the caps as
parameters.

## 7. Compatibility, data, and security

- **No schema, host-core, or settings change.** The catalogue is read through
  existing methods; credentials through `providers.getSecret`, which main already
  uses for image generation.
- **Plugin SDK stays additive.** New members and optional fields only. Root
  `AGENTS.md` forbids changing Plugin SDK contracts; nothing here does.
- **No credential crosses the process boundary.** The sidecar→main payload
  carries `providerId`, not a key; tests assert no key material appears in the
  payloads of the three methods, in any catalogue row, or in any extension-visible
  result.
- **Threat model delta.** Before, a plugin with `agent.extension` could read the
  session model and run bash in the sidecar. After, with `models.list` and
  `provider.request`, it can also enumerate providers and models and issue
  authenticated requests to any path on a provider's `baseUrl`. That is a real
  expansion — it is why `provider.request` is a separate high-risk grant with
  install-time confirmation, per-call audit, a brake, and a bounded budget. The
  destination origin and the credential header remain host-owned, so the
  expansion does not become credential exfiltration or SSRF.
- **Least privilege.** The catalogue carries no credential; the caller cannot
  change origin, escape the base path, or override the credential header; HTTP
  status is returned rather than reinterpreted; redirects are not followed, so
  the credential is never re-sent elsewhere; bodies and headers are capped.
- **Uploads stay inside the session.** An uploaded file must resolve inside the
  project, scratch, or attachment roots, under the caps in D8. For an extension
  that already holds `agent.extension` this is containment, not isolation — its
  modules can read those files anyway with bash — but it keeps main from becoming
  a general file-read-and-send primitive and keeps the credential out of reach of
  anything outside those roots.

## 8. Verification

Proportional to a new authenticated-request boundary; each stage in §9 is
verified on its own.

- **Unit**: the §5.3 path table (accepted, plus absolute URL, `//host`, `..`,
  `%2e%2e`, backslash, fragment, control characters, empty, oversize, and the
  prefix-escape case), header composition and denylist, credential-header
  precedence, method/body/timeout validation, response shape and caps, error
  mapping, and the brake. Multipart gets its own matrix: the §5.1 body union
  (including a body on `GET`), boundary and `content-type` ownership, part
  metadata validation, the containment table (in-root, `..`, absolute escape,
  symlink out of root, `attachments/<sha256>` outside the store, a file that grows
  past its cap mid-read), and each of the four file error codes.
- **Contract**: pi `ModelRegistry` conformance — every supported member matches
  its upstream signature and behaviour, every unsupported member exists, returns
  the neutral value, and emits exactly one diagnostic per extension (G7, spec 16
  §5). Negative test that an unlisted `host.proxy` method is still refused.
- **Integration**: sidecar to main for the three methods against a fixture host,
  including unknown `extensionId` rejection, missing grant, `oauth` rejection,
  stale-snapshot rejection, abort, and runtime disposal.
- **E2E**: extend the existing trusted-extension harness rather than adding a
  script — `scripts/e2e-trusted-extensions.mjs` (npm script
  `test:e2e:trusted-extensions`) with fixtures
  `apps/desktop/test/e2e/trusted-extensions/{seed,drive,stub-server}.mjs`. That
  harness already drives `ctx.modelRegistry.getAvailable()`,
  `getProviderAuthStatus`, and `setModel` through a registered command, and
  already asserts the redaction property this plan depends on: it serializes the
  registry and fails if `sk-e2e`, `secret:provider:`, `authorization`, or
  `bearer ` appears (`seed.mjs` computes `registryLeaks`, `drive.mjs:196` asserts
  `=none`). The new scenarios add: a model on a second endpoint found through
  `find`, a `GET` and a `POST` issued through `ctx.providers.request` against
  `stub-server.mjs`, the fixture asserting it received the provider's credential
  header while a caller-supplied `authorization` was refused, and the path-escape
  rejections. The multipart scenarios add a `POST` whose body is
  `multipart/form-data` with one text field and one local file, asserting the
  fixture received both parts with the provider's credential header applied, that
  a caller-supplied `content-type` was refused, and that a path outside the
  session roots was rejected before any request left the host.
- **Scripts**: extend `apps/desktop/test/plugin-agent-extensions.test.mjs`,
  `plugin-complete.test.mjs`, and `plugin-timeout-budgets.test.mjs` where the
  shared brake and budget math change, and add unit tests for the projection and
  the new access module.
- **Commands**: `pnpm build:js`, `pnpm --filter @pi-desktop/desktop typecheck`,
  `pnpm lint`, `pnpm -r --if-present test`,
  `node scripts/e2e-trusted-extensions.mjs`, and `pnpm check:marketplace` (it
  reads declared permission scopes, so a new permission must not break it).
  `verify:ui:*` is not run unless the user asks in the task. Live providers and
  paid endpoints stay opt-in, never a default test path.
- No command is reported as passing unless it ran.

## 9. Delivery stages

Each stage builds, is independently verifiable, and leaves no dead code behind.
Each stage that moves a member out of the unverified class lands its own ADR and
spec update in the same stage — spec 16 §13 forbids a member becoming supported
before the decision that moves it exists.

- **S1 — information (G1, G2, G3, G7).** Every not-yet-supported `ModelRegistry`
  member becomes present and inert with one diagnostic; the ready-model projection
  lands in main with `extensions.providers.list`; the sidecar snapshot
  (Runner-scoped) and `refresh` land; `getAvailable` / `find` / auth status become
  truthful. ADR + spec 16 §5 update for the projection and the `models.list` gate,
  reconciling ADR 0258 decision 4. Order inside the stage: inert members first,
  then the projection. This stage alone lets the reported plugin discover
  `image2` on another endpoint and decide what to do about it.
- **S2 — requests (G4, G5).** The `provider.request` grant in every copy, the
  three RPC methods, path validation, provider-row and credential resolution,
  header composition, body assembly including multipart, the contained-file
  reader extraction, the response contract, the brake, the abort registry, and the
  audit line. ADR + spec updates: spec 16 §5 and §10.1, spec 12 §6.1 declaration
  and audit names, spec 13 permissions matrix, spec 03 error codes if new codes
  are added.
- **S3 — surfaces.** `docs/plugin-development.md` §1/§6.12/§7/§12 and its zh-CN
  mirror, the devkit types and hint tables (a declared permission is now looked
  for in the entry file *and* in every `contributes.agentExtensions` module, so
  a provider call in an extension is no longer reported unused), the
  `examples/plugins/provider-request` example, and the `docs/project/README.md`
  index. Both permission-enum drifts in §6 are fixed in this stage, not widened
  and not left as follow-ups.

An ADR is required before the implementation of the stage that needs it, not
after: this adds public extension contract members, a new high-risk grant, and a
new way for extension code to reach the user's providers with a credential
(root `AGENTS.md` §4).

The only refactor is the contained-file reader extraction from `image-inputs.ts`
(§6), which keeps one containment rule instead of two. Nothing else in the image
service, the completion path, or `plugin-runtime.ts` is touched.

## 10. Decisions and open questions

Settled during review:

- `providerId` is **required** and is never inferred (D3). This is a general API
  extension: the caller names the target on every call.
- The request grant is `provider.request` (parallel to `provider.register`).
- No thin `modelRegistry.complete` layer (N2). It is additive later, and it would
  need an `AssistantMessage` mapping whose `usage.cost` and `stopReason` cannot
  be faithful.

Everything below is a choice this plan assumes a default for, or one a later
stage must confirm.

| Question | Default until decided |
|---|---|
| OAuth-backed providers as request targets | rejected in v1 (D5); enabling it means model-dependent endpoint resolution and a per-call auth handle |
| Caller-supplied headers | allowed behind the D5 denylist; the alternative is refusing them entirely and relying on the provider row's configured headers |
| Share the rate brake with the plugin surface's `agent.complete` counter | share one counter per plugin (D8) |
| Caps: 1 MiB non-multipart body, 4 MiB response body, 60 s default budget, 300 s maximum | as stated; the 2048-byte path and the provider-header caps come from existing constants |
| Multipart caps: ≤ 8 files, ≤ 32 MiB per file, ≤ 64 MiB total | one step larger than the shipped image tiers (16 MiB/file, 32 MiB/set); the shared reader takes the caps as parameters |
| Content-type sniffing for uploaded files | none; an unspecified type is `application/octet-stream` and correctness is the caller's responsibility |
| Response body representation | `json` / `text` / `base64` with a byte count, chosen by content type |
| `getAll` semantics: same ready set as `getAvailable`, or a wider "known models" set | same ready set; record the divergence in the ADR |
| Push catalogue invalidation when providers change | no; refresh at the next extension load or an explicit `refresh()` |
| `getProvider` and `isUsingOAuth` | stay inert |

## 11. Acceptance criteria

Done when, for a plugin whose extensions are loaded in a session and which holds
`agent.extension`, `models.list`, and `provider.request`:

1. `ctx.modelRegistry.getAvailable()` returns every ready host model plus
   plugin-registered agent models, and no row carries key material.
2. `ctx.modelRegistry.find("<provider-on-a-second-endpoint>", "image2")`
   resolves that model, and `getProviderAuthStatus` reports its real auth state
   without any secret.
3. `ctx.providers.request({ providerId, modelId, path: "/images/generations",
   method: "POST", body: {...} })` reaches
   `<provider baseUrl>/images/generations` with the provider's credential applied
   by the host, and returns the provider's status and body unchanged. A call that
   omits `providerId` is `INVALID_ARGUMENT`; there is no default provider (D3).
4. A caller cannot change the destination origin, escape the base path
   (`/../`, `/%2e%2e/`), set `authorization`, set `content-type`, or observe a
   3xx being followed.
5. `ctx.providers.request({ providerId, modelId, path: "/images/edits",
   method: "POST", body: { kind: "multipart", fields: [{name: "model", ...},
   {name: "prompt", ...}], files: [{name: "image", path: "<in session>"}] } })`
   reaches `<provider baseUrl>/images/edits` as a correctly bounded
   `multipart/form-data` body with the host-generated boundary and the provider's
   credential applied.
6. A `multipart.files` path outside the project, scratch, and attachment roots is
   rejected with `FILE_OUTSIDE_ALLOWED_ROOTS` before any request leaves the host;
   a missing file, an oversized file, and an oversized payload report
   `FILE_NOT_FOUND`, `FILE_TOO_LARGE`, and `UPLOAD_TOO_LARGE`.
7. Provider-configured headers are applied, caller headers are merged under the
   caps, and the credential header cannot be overridden.
8. A call without `provider.request` fails with `PERMISSION_DENIED` and an audit
   line; an `extensionId` outside the session's loaded set is rejected; an
   extension holding only `agent.extension` still loads and works as before.
9. Every unsupported `ModelRegistry` member exists, returns its neutral value,
   and emits one diagnostic per extension per member; none throws.
10. Existing plugin `models.list` and `agent.complete` behavior, existing image
   generation through the `GenerateImages` tool, and existing session bindings
   are unchanged, with no host-core, protocol, or schema change.

## 12. Risks

| Risk | Mitigation |
|---|---|
| A generic authenticated request is the widest capability on this surface | its own high-risk grant, install-time confirmation, per-call audit, brake, in-flight cap, bounded budget, fixed origin, no redirect following |
| A path-join bug becomes SSRF or credential redirection | two-layer validation (pre-parse decoding + post-normalization prefix and origin assertions) with an explicit test table (§5.3), enforced in main |
| A sibling plugin's grant is usable from the same sidecar process | documented residual limit; union-of-grants rule, install-time consent, per-call audit; isolation would need a separate process (out of scope) |
| A non-idempotent request is duplicated by a retry | no automatic retry on this path; `retryAfterMs` is surfaced for the caller to pace itself |
| Upload becomes a general "read any host file and send it to a provider" path | containment to the project, scratch, and attachment roots with realpath checks, per-file and total caps, and an audit line that records counts and bytes but never paths or field values |
| A multipart boundary or `content-type` mismatch corrupts the request | the host builds the envelope and generates the boundary, and a caller-supplied `content-type` is refused (D3, D5) |
| A stale catalogue misleads a caller into choosing a removed model | main re-resolves the provider and model at call time and rejects |
| `getAll` semantics diverge from upstream | projected identically to `getAvailable`, recorded in the ADR |
| Redaction regresses and a row or payload carries a key | projection unit tests plus E2E assertions on sidecar wire payloads and on the fixture's received headers |
| Audit logs leak a query string that carries a secret | the audit line logs the path without its query |
| `runtime.ts` grows while being extended | the new code lives in its own module; `runtime.ts` gains wiring only |

## 13. Out of scope, recorded for later

- OAuth-backed providers as request targets (N5).
- `modelRegistry.complete` / streaming completions from extensions (N2).
- A request API on the sandboxed plugin surface: it needs a new
  `HOST_API_ALLOWLIST` entry, a `PluginHostServices` member, a `buildApi()` proxy
  in `plugin-host-process.mjs`, devkit hint tables, and the spec 12 §6.1
  obligations. `plugin-runtime.ts` is already 5694 LOC and would have to reckon
  with the 800 LOC module ceiling.
- Per-extension process or module isolation, which would turn the grants in D7
  into a real security boundary instead of a brake.
- Image capability metadata as a host-core column; the catalogue derives it from
  models.dev modalities where useful.
- Pushing catalogue invalidation into running Runners.
