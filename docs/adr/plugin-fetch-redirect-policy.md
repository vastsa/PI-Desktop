# ADR: Host-enforced plugin fetch redirect policy

- Status: Accepted (implementation candidate for #1475)
- Date: 2026-10-08

## Context

Plugins connecting to user-selected endpoints need to refuse or inspect a
redirect before the host contacts its destination. An optional request field
alone is insufficient for old hosts that ignore unknown options.

## Decision

Add follow/error/manual to the existing SDK request and a read-only
`net.getCapabilities` query. Keep omitted mode equivalent to legacy follow.

## Consequences

- Post-response inspection cannot prevent a followed request and is rejected.
- A release-version check alone cannot identify development hosts; capability
  detection lets a plugin refuse unsupported hosts before sending anything.
- A same-origin-only mode is optional in the issue and deferred to keep the
  additive API small.
- The host must continue testing the injected transport as well as the default
  path.

The contract and acceptance live in the plugin API spec and
E2E-PLUGIN-fetch-redirect-policy, not this decision record.
