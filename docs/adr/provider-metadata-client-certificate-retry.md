# ADR: Provider metadata recovery from optional client certificate requests

- Status: Implemented candidate
- Date: 2026-10-16
- Related: issue #1676, ADR 0177, `03-runtime/07-process-model.md`

## Context

Electron 43 leaves its client certificate responder unimplemented, so a server
requesting an optional client certificate aborts model metadata discovery with
`net::ERR_SSL_CLIENT_AUTH_CERT_NEEDED` before HTTP is sent, even when it accepts
an empty client identity. Electron 44 (issue Electron #52162) fixes this but
drops macOS 12 support and changes the clipboard API.

## Decision

Keep Chromium as the primary transport but extract the metadata transport from
model discovery and connection probes, and on exactly the
client-auth-certificate error retry that HTTPS GET or OPTIONS once through Node
TLS without a client identity. The retry travels over the existing
authenticated loopback SOCKS relay, whose resolver consults the default Chromium
session including System/PAC, Direct, and custom proxy configuration, with no
direct fallback when proxy routing fails; it keeps the original AbortSignal and
manual redirect mode, uses bundled and OS CA roots per request without changing
process-wide TLS settings, and owns and closes its tunnel, socket, and agent.
Nothing else retries: no global fetch fallback, no agent turns, plugin
requests, ordinary HTTP responses, unrelated TLS failures, or cancelled work.

## Consequences

- Optional client authentication reaches ordinary HTTP responses while
  mandatory client authentication still fails.
- There are no persistence, IPC, or plugin contract changes, and the retry
  fails closed where proxy authentication is interactive or OS-integrated.
- The compatibility retry is removed once a validated runtime provides native
  recovery.

## Alternatives

- Electron 44: the upstream solution, but it needs its own platform and API
  migration decision.
- Replace global fetch with Node: rejected, it changes unrelated networking,
  cookies, proxy authentication, and plugin behavior.
