# Explicit provider import into a running remote Host

- Status: Accepted for the experimental SSH MVP
- Refines: ADR 0292, ADR 0293; remote architecture §5.2 and security §3.5

## Context

A fresh SSH Host cannot chat until it has a usable provider/model. RACP must not
become a credential relay, and starting a second host-core to import configuration
would violate the single-writer lifecycle. Automatic copying would also transfer
more credentials than the user intended.

## Decision

Keep the existing ownership model. The user selects eligible providers and
confirms credential copying in Settings. Main reads only those secrets, validates
a versioned bounded payload, and writes it to an explicit SSH command's stdin.
`pi-host provider-import` forwards the payload to the running Host over an
owner-only Unix socket. The socket accepts only provider import and uses the
Host's existing Rust RPC connection. It is not a general-purpose RPC tunnel.

Directory/socket permissions, a process ownership lock, connection/request
limits and deadlines bound the new local channel. A private digest receipt
journal makes identical retries additive and idempotent without storing raw
credentials. Uncertain creation is reported rather than silently repeated.

## Alternatives

- Sending secrets through RACP would expand the network credential boundary.
- A standalone database importer would introduce a second writer and bypass
  existing provider validation and secret storage.
- Automatic bulk copying would make consent and minimum disclosure unclear.

## Consequences

No database schema, AgentEvent or RACP operation changes. Provider import requires
a running same-version Host and a Unix SSH target. OAuth, local CLI/plugin
providers and local-only endpoints are not portable. Existing remote rows are
never overwritten; changed input creates a new row, and an incomplete receipt
needs operator diagnosis rather than an unsafe automatic retry. Publishing the
matching Host bundle and real Linux SSH acceptance remain release responsibilities.
