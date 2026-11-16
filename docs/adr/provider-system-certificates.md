# ADR: Desktop sidecar uses the operating system's trusted certificates

- Status: Accepted
- Date: 2026-09-20
- Related: ADR 0177, ADR 0271, issue #714

## Context

HTTPS inspection can present a chain anchored in a locally installed trusted root,
but Chromium and the agent sidecar use different TLS implementations, so the
sidecar's bundled roots can reject a chain the operating system trusts. Node's
`--use-system-ca` covers Windows and Linux, yet on macOS that build replaces the
bundled Mozilla roots with an enumerated system set missing public anchors, so a
GlobalSign-anchored chain fails with `UNABLE_TO_GET_ISSUER_CERT` (issue #1187).

## Decision

The desktop launcher passes `--use-system-ca` before the sidecar entry point on
Windows and Linux; on macOS it omits the flag and the sidecar merges its bundled
roots, the inherited `NODE_EXTRA_CA_CERTS` set, and the system-store certificates
into the default CA set at startup (`tls.setDefaultCACertificates`, agent-runtime
`system-ca`), deduplicating by content and omitting certificates already expired in
the OS store. Certificate chain, expiration, and hostname validation stay enabled,
the app neither installs roots nor exports a bundle, and the operating system's trust
policy is the authority for local roots. The process-level default covers the
sidecar's default Node TLS clients, including the direct, HTTP proxy, and SOCKS
provider transports, while headless `pi-host` launch policy is unchanged. Explicit
certificate verification codes make `NETWORK_ERROR` non-retriable and exclude it from
transport rebuilding, before setup replay and after the adapter flattens the error,
for both session and built-in delegates.

## Consequences

- Organizations that install trusted inspection roots extend that trust to the
  desktop sidecar, while untrusted chains and hostname mismatches remain rejected.
- No IPC fields, database format, credentials, or proxy settings change, and changing
  roots or the extra-CA environment requires a desktop restart.
- The transcript explains certificate validation failure without asserting that
  security software is the cause.

## Alternatives

- Export Windows stores to PEM: adds platform-specific subprocesses and duplicate
  trust-policy maintenance.
- Add a custom-CA setting: `NODE_EXTRA_CA_CERTS` already covers it.
