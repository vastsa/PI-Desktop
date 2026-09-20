# ADR: Desktop sidecar uses the operating system's trusted certificates

- Status: Accepted
- Date: 2026-09-20
- Related: Issue #714, ADR 0177, ADR 0271

## Context

HTTPS inspection can present a chain anchored in a locally installed trusted
root. Chromium and the agent sidecar use different TLS implementations; the
sidecar's bundled roots alone can reject a chain trusted by the operating
system. Rebuilding an undici pool does not change that trust decision.

The current Electron 43 runtime supports Node's `--use-system-ca`. A Windows
probe of Electron 43.6.0 / Node 24.20.0 confirmed that this flag includes the
system roots in the default CA set. The older Node 22.16.0 behavior reported in
#714 is not evidence that the current packaged runtime lacks this capability.

## Decision

The desktop launcher passes `--use-system-ca` before the sidecar entry point.
Node combines its bundled roots with system roots and inherited
`NODE_EXTRA_CA_CERTS`. Certificate chain, expiration and hostname validation
remain enabled. The app neither installs roots nor exports a certificate bundle.
The operating system's existing trust policy is the authority for local roots.

This applies to the desktop sidecar's default Node TLS clients, including the
direct, HTTP proxy and SOCKS provider transports. It is a process-level default,
not a per-provider exception. Headless pi-host launch policy is unchanged.
Restart the desktop after changing roots or its extra-CA startup environment.

Explicit certificate verification codes make `NETWORK_ERROR` non-retriable
and exclude it from transport rebuilding. The same classification is used
before setup replay and after the adapter flattens the error, for both the
session and built-in delegates. Other TLS/protocol failures retain their
existing recovery behavior. The transcript explains certificate validation
failure without asserting that security software must be its cause.

## Alternatives

- Exporting the Windows stores to PEM adds platform-specific subprocesses,
  filesystem lifecycle, and duplicate trust-policy maintenance. The current
  runtime's native support avoids those costs.
- A new custom-CA setting introduces persistence and restart semantics. The
  inherited `NODE_EXTRA_CA_CERTS` option already remains available.
- Disabling certificate or hostname verification is unacceptable.
- Suppressing every `tls` category is too broad: that category also includes
  protocol errors, not just certificate validation failures.

## Consequences and validation

Organizations that install trusted inspection roots now extend that trust to
the desktop sidecar. Untrusted chains and hostname mismatches remain rejected.
No IPC fields, database format, credentials, or proxy settings change.

`scripts/e2e-provider-certificates.mjs` exercises the real desktop launcher,
bundled sidecar, pi-ai and a loopback HTTPS provider. It checks inclusion of
system roots without modifying OS stores, then rejection of an untrusted root,
success with an inherited extra CA, and rejection of a mismatched hostname.
Native macOS/Linux and the reporter's security product require separate checks.
