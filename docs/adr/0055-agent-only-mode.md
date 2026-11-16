# ADR 0055: Agent-only mode; Chat becomes an internal read-only profile

- Status: Superseded by ADR 0052 / ADR 0053, which reintroduced the mode concept
  as the Plan operating state
- Date: 2026-08-05
- Related: D003, D004, D115, D119, D185, D188, D189, D191

## Context

Since D003/D004 a session carried an `agent` profile with the full coding surface
or a `chat` profile with a read-only subset (`Read`, `Glob`, `Grep`) that
host-core hard-denies past every permission mode (D115). `chat` was never a
destination, yet the UI advertised it as a peer choice, and the profile could not
simply be deleted because imported and older rows carry `mode` values the current
UI does not produce.

## Decision

`agent` became the only exposed mode and `chat` was renamed `read-only`
(`Mode = "read-only" | "agent"`), with a negative gate — `PermissionManager`
denies when `mode != "agent"` and the tool is outside `read_only_mode_allows` —
so a legacy `mode` fails closed rather than gaining Write, Edit, or Bash.
Error codes became `BASH_DISABLED_IN_READ_ONLY` and
`WRITE_DISABLED_IN_READ_ONLY`, and `chat` rows migrated to `agent` at open.

ADR 0052 / ADR 0053 supersede this record: the product again exposes an
`Agent | Plan` selector, `chat` migrates to `plan` rather than `agent`, and the
reasoning about a negative gate and about failing closed on an unknown `mode`
value still holds.
