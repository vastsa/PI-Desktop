# ADR: Desktop sidecar uses the operating system's trusted certificates

- Status: Accepted
- Date: 2026-09-20
- Related: Issue #714, ADR 0177, ADR 0271

## Context

HTTPS inspection can present a chain anchored in a locally installed trusted
root. Chromium and the agent sidecar use different TLS implementations; the
sidecar's bundled roots alone can reject a chain trusted by the operating
system.

## Decision

The desktop launcher passes `--use-system-ca` before the sidecar entry point on
Windows and Linux. On macOS the launcher omits the flag; instead the sidecar
merges its bundled roots, the inherited `NODE_EXTRA_CA_CERTS` set, and the
system-store certificates into the default CA set at startup
(`tls.setDefaultCACertificates`, agent-runtime `system-ca`).

This applies to the desktop sidecar's default Node TLS clients, including the
direct, HTTP proxy and SOCKS provider transports. It is a process-level default,
not a per-provider exception.

## Alternatives

- Exporting the Windows stores to PEM adds platform-specific subprocesses,
  filesystem lifecycle, and duplicate trust-policy maintenance.
- A new custom-CA setting introduces persistence and restart semantics.
- Disabling certificate or hostname verification is unacceptable.
- Suppressing every `tls` category is too broad: that category also includes
  protocol errors, not just certificate validation failures.

## Consequences and validation

Organizations that install trusted inspection roots now extend that trust to the
desktop sidecar.

`scripts/e2e-provider-certificates.mjs` exercises the real desktop launcher,
bundled sidecar, pi-ai and a loopback HTTPS provider.
