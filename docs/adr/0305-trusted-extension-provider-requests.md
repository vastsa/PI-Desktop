# ADR 0305: Trusted-extension provider requests

- Status: Accepted for implementation
- Date: 2026-09-21
- Deciders: PI-Desktop core
- Amends: ADR 0304 (adds the execution member that record deferred)
- Related: ADR 0134, ADR 0174 (D336), ADR 0258 (decision 4), spec 16 §5 / §10.1 /
  §13, spec 12 §6.1 / §8, spec 13, spec 03 §4 / §5, spec 03 §11

## Context

ADR 0304 landed the information surface: a plugin can now discover the user's
ready providers and models and read truthful auth availability. It deliberately
deferred execution. The reported use case needs more: an authenticated request to
a path the plugin chooses on a provider the user configured, so a plugin can
speak a protocol the host knows nothing about.

Nothing on the existing surfaces can do that. `agent.complete` is bound to the
plugin host's own registered models. The session's chat adapter is protocol-bound
and rejects the targets this feature exists to reach. `tools.execute` runs a
process, not an authenticated HTTP request, and its authorization says nothing
about spending money at a provider. A generic authenticated request is the widest
capability on this surface, so it needs its own grant, its own bounds, and its own
record.

## Decision

1. **One execution member, protocol-agnostic.** `ctx.providers.request(input)`
   takes a `(providerId, modelId?)`, a method, a caller-supplied path, optional
   headers, and a typed body. It is deliberately not a completion API: the host
   contributes the destination origin, the credential, and the transport policy,
   and interprets nothing. The caller receives the provider's status and body.
   The caller's path is what makes `/chat/completions`, `/images/generations`,
   `/embeddings`, or any other endpoint reachable without the host growing one
   endpoint per protocol.
2. **Path joining is append-only, prefix-preserving, and enforced in main.** The
   final origin must equal the provider row's origin, and the final pathname must
   start with the row's base pathname. Validation happens in two layers: the
   caller string is checked *before* any URL construction (no backslash, `#`,
   control characters, `//` prefix, empty, or over 2048 bytes; percent-decoded up
   to two passes and rejected when a `..` segment survives), and the assembled URL
   is checked again after normalization, which catches any encoding the first
   layer missed. No implicit `/v1`: the row's `baseUrl` is used as configured.
3. **Credentials and headers stay host-owned.** The host resolves the provider row
   and reads its secret through `providers.getSecret`; the caller never sees it and
   cannot override it. A caller-supplied `authorization`, `cookie`, `set-cookie`,
   `host`, `content-length`, `connection`, `transfer-encoding`, `upgrade`,
   `proxy-authorization`, `x-forwarded-*`, or `content-type` is refused, because
   for a multipart body the boundary must match what the host built. Callers that
   need a content type set it on the body.
4. **The body is a discriminated union:** `json`, `text`, `base64`, or
   `multipart`. The host serializes, generates the multipart boundary, and never
   sniffs file content: an unspecified type becomes `application/octet-stream` and
   type correctness is the caller's responsibility. Part metadata is validated
   (bounded `name`/`value`, no control characters, no path separator in
   `filename`). A body on `GET` is refused; every other method accepts every body
   kind, because the host does not adjudicate protocol semantics.
5. **Uploads read only from roots the session owns.** A `multipart.files` entry is
   resolved with `realpath` against the `realpath` of the project root, the
   scratch directory, and the attachment store; the resolved file must sit
   strictly inside one of them, and the read is re-bounded as it happens so a file
   that grows after `stat` cannot overrun. Caps: at most 8 files, at most 32 MiB
   per file, at most 64 MiB in total. The containment rule and the bounded read
   are extracted from the shipped image input loader rather than duplicated, so
   one security rule keeps one source of truth; the image path keeps its own
   16 MiB / 32 MiB / 64 MiB tiers and its PNG/JPEG/WebP sniffing.
6. **The response contract treats status as a result.** HTTP 4xx and 5xx are
   returned to the caller with their status, not converted into host errors.
   Redirects are not followed. There is **no automatic retry** on this path:
   a non-idempotent POST bills per call. `retryAfterMs` is surfaced for the caller
   to pace itself. An oversized response body is rejected, never truncated.
7. **A new high-risk grant `provider.request` gates the member**, registered in
   every copy of the permission list, shown at install time, and audited per call.
   Subject resolution, the union-of-grants rule, and the "main-owned state only"
   rule are those of ADR 0304.
8. **Brakes and budgets.** Eight requests per rolling 60 s per plugin, sharing the
   counter the plugin host already uses for `agent.complete`; four requests in
   flight per plugin; a 60 s default per-call budget with an explicit maximum of
   300 s; and a transport deadline of budget + 15 s passed as an explicit
   override, because the shared `rpcTimeoutMs` default cannot know the caller's
   budget.
9. **Cancellation is explicit and bidirectional.** The caller may pass a signal;
   the sidecar mints a `callId` and sends it with the request; main registers an
   `AbortController` keyed by `(sessionId, callId)`, aborts the fetch on the abort
   method, and clears the entry when the call settles — on success, on failure, on
   runtime disposal, and on session switch.
10. **Three allowlisted host-proxy methods**: `extensions.providers.list` (ADR
    0304), `extensions.providers.request`, and `extensions.providers.abort`. The
    request method carries the claimed `extensionId` for audit attribution only.

## Consequences

- A plugin holding `provider.request` can reach the whole provider API surface
  with the user's credential: any path, any method, including endpoints that spend
  money and endpoints that read account resources. That is a real expansion, and
  it is the reason for a separate install-time confirmation, a per-call audit
  line, a brake, an in-flight cap, and a bounded budget. The origin and the
  credential header stay host-owned, so the expansion is not credential
  exfiltration and not SSRF.
- The brake is a brake, not a security boundary, and the sidecar still runs every
  module of a session in one process: with several contributing plugins, a module
  can use a sibling's grant (ADR 0304's residual limit). Per-extension isolation
  would need a separate process or module scope, which spec 16 §4.3 does not
  provide.
- The upload containment constrains what the host resolves on the caller's behalf.
  It does not restrict what a module could already read with bash; it exists so
  this API cannot become a general "read any host file and send it to a provider"
  primitive.
- One refactor is required and is behavior-preserving: the contained-file reader
  extraction. The image path keeps its caps and sniffing, proven by its existing
  tests.
- Uploads are bounded and buffered: no streamed or chunked request bodies and no
  streaming responses. A caller that needs streaming does not get it from this
  member.
- No host-core RPC, database schema, or setting changes. The plugin SDK gains one
  permission id and no new contract member.
- New failure codes join spec 03 §4's error model, and the multipart file codes
  are host-side rejections: the request never leaves the host when a path is
  refused, a cap is exceeded, or a part is malformed.

## Alternatives

- **Reuse the authorization of `tools.execute`.** Rejected: that grant is about
  running a process in the workspace, not about spending the user's provider
  credential, and it says nothing to the user at install time about which one
  they are approving.
- **Add a `complete` member instead.** Rejected: it would bake one protocol into
  the host, invent a response mapping whose usage and stop reason cannot be
  faithful, and leave every other endpoint unreachable.
- **Give the host an image-generation endpoint.** Rejected: protocol-specific
  surface that grows one endpoint per plugin need; the plugin composes its own
  protocol on top of the generic request instead.
- **Certificate-pin or path-allowlist per provider.** Deferred rather than
  rejected: the endpoint grammar is intentionally open, and the guard rails are
  origin, containment, caps, audit, and the brake.
- **Hand the plugin a credential and let it fetch directly.** Rejected: the
  credential would cross into a process that also holds bash and shared module
  scope.
