# ADR: Provider metadata recovery from optional client certificate requests

- Status: Implemented candidate
- Date: 2026-10-16
- Related: issue #1676, ADR 0177, `03-runtime/07-process-model.md`

## Context

Electron 43's net module leaves its client certificate responder unimplemented.
A server requesting an optional client certificate therefore aborts model
metadata discovery with `net::ERR_SSL_CLIENT_AUTH_CERT_NEEDED` before HTTP is
sent, even when it accepts an empty client identity.

## Decision

Keep Chromium as the primary transport. Extract the metadata transport from
model discovery and connection probes.

The retry uses the existing authenticated loopback SOCKS relay. Its resolver
consults the default Chromium session, including the active System/PAC, Direct,
custom proxy and bypass configuration.

## Consequences

Optional client authentication reaches ordinary HTTP responses; mandatory client
authentication still fails.

A focused Electron E2E reproduces the original failure and exercises actual
model discovery and connection tests through direct and authenticated proxy
routes.

## Alternatives

- Electron 44: the upstream solution, but requires a separate platform/API
  migration decision.
- Only add an app event handler: Electron 43 never emits it for net requests.
- Replace global fetch with Node: changes unrelated networking, cookies, proxy
  authentication and plugin behavior.
- Disable server certificate checks: unrelated to the root cause and unsafe.
