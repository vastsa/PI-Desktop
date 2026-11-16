# ADR: Explicit provider import into a running remote Host

- Status: Accepted for the experimental SSH MVP
- Refines: ADR 0292, ADR 0293; remote architecture §5.2 and security §3.5

## Context

A fresh SSH Host cannot chat until it has a usable provider and model, RACP must
not become a credential relay, and starting a second host-core to import
configuration would violate the single-writer lifecycle.

## Decision

The user selects eligible providers and confirms credential copying in Settings;
Main reads only those secrets, validates a versioned bounded payload, and writes
it to an explicit SSH command's stdin. `pi-host provider-import` forwards the
payload to the running Host over an owner-only Unix socket that accepts only
provider import and uses the Host's existing Rust RPC connection instead of being
a general-purpose tunnel. Permissions, a process ownership lock, connection and
request limits, and deadlines bound the channel, and a private digest receipt
journal makes identical retries idempotent without storing raw credentials.

## Consequences

- No database schema, AgentEvent, or RACP operation changes, and existing remote
  rows are never overwritten.
- Import requires a running same-version Host and a Unix SSH target, and OAuth,
  local CLI providers, and local-only endpoints are not portable.
- Uncertain creation is reported for operator diagnosis rather than retried
  silently.

## Alternatives

- Sending secrets through RACP: rejected; it expands the network credential
  boundary.
- A standalone database importer: rejected; it introduces a second writer.
