# ADR: Host-enforced plugin fetch redirect policy

- Status: Accepted (implementation candidate for #1475)
- Date: 2026-10-08

## Context

A plugin connecting to a user-selected endpoint must refuse or inspect a
redirect before the host contacts its destination, which an optional request
field cannot do on old hosts that ignore unknown options, and the injected fetch
service returns a fully materialized response, too late for the host to decide.

## Decision

Add follow/error/manual to the existing SDK request plus a read-only
`net.getCapabilities` query, keeping an omitted mode equivalent to legacy
follow. The hop loop moves into a focused host module whose injection seam is a
single-hop transport receiving manual redirect mode and the shared abort signal,
so the plugin-child RPC and the panel bridge share one policy.

## Consequences

- Post-response inspection cannot prevent a followed request and is rejected.
- Capability detection lets a plugin refuse an unsupported host before sending
  anything, which a version check cannot do for development hosts.
- Grants, request rewriting, storage, and sandbox boundaries are unchanged,
  while transports must honor manual redirect and abort semantics.
