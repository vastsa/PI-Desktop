# ADR 0304: Trust the network endpoints the user enters themselves

- Status: Accepted for implementation
- Date: 2026-09-22
- Related: ADR 0142, ADR 0177, ADR 0243, ADR 0245, ADR 0247, ADR 0257, ADR 0272, ADR 0300

## Context

ADR 0243, ADR 0245, ADR 0247 and ADR 0272 built one public-network boundary and
applied it to every request the app makes on its own behalf: a market source, a
redirect hop, a git remote, a resolved address. That boundary is load-bearing. A
catalog body the app did not receive from the user must not be able to point the
main process at the machine's own network.

The same boundary also fell on addresses the user typed into a settings field: a
self-hosted GitLab at `192.168.1.5`, a LAN ComfyUI at
`http://192.168.1.5:8188`, an MCP OAuth authorization server on a private
address, a catalog served by a machine in the same room. Those are not
third-party content. The user already knows that machine, and refusing the
address did not remove the request — it moved the same work into curl, a
browser, or an application-external git remote, while the app's own copy of the
feature could not be used at all.

Three surfaces had already made that distinction. ADR 0142 accepts a
non-loopback HTTP MCP endpoint with an explicit risk disclosure; ADR 0300
accepts a WebDAV endpoint on a private address under an acknowledgement; ADR
0257 lets a declared `net.domains` entry name a loopback or private host. Git
clone, market sources, MCP OAuth and generated-image download had not, and the
result was one boundary with two different meanings in it.

## Decision

1. A **user-supplied endpoint** may reach loopback, RFC1918, CGNAT, link-local,
   ULA, site-local and `.local` addresses, as well as any public address. It is
   an address the person typed: a model base URL, an MCP server, a market source
   URL, a git remote, a generated-image URL from a provider they configured.
2. One host-owned switch, **Relaxed network mode**
   (`settings.networkPolicy.mode`, `relaxed` | `strict`), **defaults to
   `relaxed`**. Relaxed is what lets such an endpoint resolve to loopback or a
   LAN address, lets it use plain `http`, and tolerates a transparent proxy's
   fake-IP answers; `strict` keeps the public-HTTPS-only boundary for those
   endpoints too. The mode is the only switch: the earlier per-surface
   acknowledgements (the plaintext flag, the WebDAV HTTP checkbox, the fake-IP
   opt-in) are folded into it, and a stored `allowInsecureUserEndpoints: false`
   migrates to `strict`. The first plaintext hop to a user endpoint tells the
   shell once, and the acknowledgement is recorded in the same section.
3. **Third-party content keeps the strict policy.** A registry record, a market
   catalog body, a document URL inside a catalog, and every HTTP redirect target
   are still judged by the public-only rule, with the resolved address pinned to
   the connection. The shared client therefore takes the origin of each hop: the
   first hop of a request the user started may be `user`, and every hop after a
   redirect is `third-party` unconditionally.
4. An OAuth authorization server reached over plaintext is trusted only when it
   sits on the same host as the MCP server the user typed. Every other endpoint
   that flow reads — `WWW-Authenticate`, a protected-resource document, an
   authorization-server document, a stored token endpoint — arrives inside
   server metadata, so a server must not be able to send the app to a plaintext
   internal address the user never entered. Loopback stays allowed (RFC 8252).
5. `unspecified`, `multicast`, `reserved`, `documentation`, `invalid` and cloud
   metadata stay refused on **every** input, including a user-supplied one. None
   of them names a service a user could mean, and the metadata services answer
   with the host's own credentials.
6. The default proxy bypass list gains the private ranges, so a configured proxy
   does not swallow the user's own LAN services.
7. The syntactic judgement stays in `packages/shared`, and the authoritative one
   stays at the connection: a DNS answer outside the policy is refused before
   the socket, and an acceptable address is pinned to it (ADR 0245, ADR 0272).

## Consequences

- A model endpoint, an MCP server, a market source, a git remote and a
  generated-image URL can all point at the user's own machine or LAN from inside
  the app, instead of only from a shell next to it.
- The main process gains an SSRF-shaped capability whose targets the user typed
  on purpose. The residual risk is the settings field the user did *not* type —
  a source that redirects, a catalog body, a registry record — and those paths
  stay on the public-only policy. Refusals still name the address class, so a
  proxy fake-IP artifact is told apart from a real private target (issue #419).
- A plaintext hop to a LAN service is on by default and announced once: whatever
  credentials that endpoint accepts travel unencrypted across the local network,
  so the user is told the first time it happens and can turn the mode off.
- ADR 0247's consequence — "clone a private-host repository with an
  application-external git remote" — no longer applies. The decision items in
  ADR 0243, 0245 and 0247 that cover *user-supplied* URLs are amended here; their
  rules for third-party content are unchanged and stay in force.

## Rejected alternatives

- **Keep refusing LAN addresses for user-supplied endpoints, and document the
  workaround.** Rejected: the workaround is the same request from a different
  process, so the refusal buys no security and costs the feature.
- **Trust every address everywhere, including third-party content.** Rejected:
  that is the SSRF path the guard exists for — a catalog body, a registry record
  or a redirect is content the app received from someone else, and DNS rebinding
  makes a pre-flight check alone insufficient (ADR 0245).
- **Permit cloud metadata as well, since the user typed it.** Rejected: the
  metadata service returns instance credentials to anything that asks, it is
  never a service a user runs, and an address that appears in a settings field
  is far more likely to be an injected payload than a deliberate choice.
- **Per-source acknowledgement stored with the source list.** Rejected: the
  source list lives in renderer storage, where a flag is exactly as trustworthy
  as the URL next to it, so it would add UI without adding a boundary. The
  acknowledgement belongs in host-owned settings, where `settings.set` is the
  single writer.
