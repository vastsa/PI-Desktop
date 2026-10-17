# ADR: Host-enforced plugin fetch redirect policy

- Status: Accepted (implementation candidate for #1475)
- Date: 2026-10-08

## Context

Plugins connecting to user-selected endpoints need to refuse or inspect a
redirect before the host contacts its destination. An optional request field
alone is insufficient for old hosts that ignore unknown options. The existing
injected fetch service also returns a fully materialized response, too late for
the host to own redirect decisions.

## Decision

Add follow/error/manual to the existing SDK request and a read-only
`net.getCapabilities` query. Keep omitted mode equivalent to legacy follow.
Move the existing hop loop into a focused host module and make the internal
injection seam a single-hop Fetch-compatible transport receiving manual redirect
mode and the shared abort signal. There are no production callers of the old
injection shape. Both plugin-child RPC and the panel bridge use the same policy.

## Consequences

- Post-response inspection cannot prevent a followed request and is rejected.
- A release-version check alone cannot identify development hosts; capability
  detection lets a plugin refuse unsupported hosts before sending anything.
- A same-origin-only mode is optional in the issue and deferred to keep the
  additive API small. This change does not alter grants or default request
  rewriting, storage, process ownership, or sandbox boundaries.
- The host must continue testing the injected transport as well as the default
  path. Transports must honor manual redirect and abort semantics.

The contract and acceptance live in the plugin API spec and
E2E-PLUGIN-fetch-redirect-policy, not this decision record.
