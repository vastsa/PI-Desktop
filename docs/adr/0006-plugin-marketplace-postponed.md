# ADR 0006: Postpone the plugin marketplace; build the local plugin runtime first

- Status: Accepted
- Date: 2026-07-25

## Context

Plugin extensibility is required, but a marketplace without a stable runtime
would only distribute packages that cannot run safely, and local plugins
already satisfy the core customization demand.

## Decision

Complete the local plugin system first: loading, permissions, commands, tools,
and lifecycle. Keep the marketplace deferred with its protocol and data model
frozen, and let its first version only browse, download, verify, and manually
update packages, since trust, signing, and the remote supply chain are harder
than local execution.

## Consequences

- Users get a stable core path instead of a store experience in the short term.
- The plugin contract stays free to change while the marketplace contract is
  frozen text only.
