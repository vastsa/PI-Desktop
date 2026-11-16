# ADR: Explicit provider import into a running remote Host

- Status: Accepted for the experimental SSH MVP
- Refines: ADR 0292, ADR 0293; remote architecture §5.2 and security §3.5

## Context

A fresh SSH Host cannot chat until it has a usable provider/model. RACP must not
become a credential relay, and starting a second host-core to import
configuration would violate the single-writer lifecycle.

## Decision

Keep the existing ownership model. The user selects eligible providers and
confirms credential copying in Settings.

Directory/socket permissions, a process ownership lock, connection/request
limits and deadlines bound the new local channel. A private digest receipt
journal makes identical retries additive and idempotent without storing raw
credentials.

## Alternatives

- Sending secrets through RACP would expand the network credential boundary.
- A standalone database importer would introduce a second writer and bypass
  existing provider validation and secret storage.
- Automatic bulk copying would make consent and minimum disclosure unclear.

## Consequences

No database schema, AgentEvent or RACP operation changes.
