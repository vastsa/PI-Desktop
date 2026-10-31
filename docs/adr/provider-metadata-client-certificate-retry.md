# ADR: Provider metadata recovery from optional client certificate requests

- Status: Implemented candidate
- Date: 2026-10-16
- Related: issue #1676, ADR 0177, `03-runtime/07-process-model.md`

## Context

Electron 43's net module leaves its client certificate responder unimplemented.
A server requesting an optional client certificate therefore aborts model
metadata discovery with `net::ERR_SSL_CLIENT_AUTH_CERT_NEEDED` before HTTP is
sent, even when it accepts an empty client identity. An app-level
`select-client-certificate` listener cannot reach that path. Electron #52162
fixes it in 44, but that release also removes macOS 12 support and changes the
clipboard API. This repair retains the existing platform compatibility.

## Decision

Keep Chromium as the primary transport. Extract the metadata transport from
model discovery and connection probes. On exactly the client-auth-certificate
error, retry that HTTPS GET or OPTIONS once through Node TLS, without a client
identity. Do not install a global fetch fallback or retry agent turns, plugin
requests, ordinary HTTP responses, unrelated TLS failures or cancelled work.

The retry uses the existing authenticated loopback SOCKS relay. Its resolver
consults the default Chromium session, including the active System/PAC, Direct,
custom proxy and bypass configuration. There is no direct fallback when proxy
routing fails. The request retains its original AbortSignal and manual redirect
mode; the existing model discovery origin guard remains the only redirect owner.

Use bundled/default and OS CA roots per request, without changing process-wide
TLS settings or disabling chain, expiration or hostname verification. The
metadata attempt owns its tunnel, TLS socket and HTTP agent through response
consumption and closes them on success, failure or cancellation. A tunnel that
completes after cancellation is destroyed on arrival; the underlying existing
SOCKS handshake remains bounded by its own timeout.

## Consequences

Optional client authentication reaches ordinary HTTP responses; mandatory client
authentication still fails. There are no persistence, IPC or plugin contract
changes. The Node retry inherits the existing relay limitation for interactive
or OS-integrated proxy authentication and fails closed in those environments.

A focused Electron E2E reproduces the original failure and exercises actual
model discovery and connection tests through direct and authenticated proxy
routes. Lower-level TLS tests cover trust, hostname validation, mandatory client
authentication, redirects, compressed metadata and cancellation.

## Alternatives

- Electron 44: the upstream solution, but requires a separate platform/API
  migration decision. Remove the compatibility retry when a validated runtime
  provides native recovery and an explicit client-identity policy.
- Only add an app event handler: Electron 43 never emits it for net requests.
- Replace global fetch with Node: changes unrelated networking, cookies, proxy
  authentication and plugin behavior.
- Disable server certificate checks: unrelated to the root cause and unsafe.
