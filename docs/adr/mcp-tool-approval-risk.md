# ADR: User MCP tools keep the normal approval path

- Status: Accepted
- Date: 2026-10-03
- Decision: D640

## Context

User-configured MCP servers expose tools under the `mcp_<serverId>_<tool>`
namespace (ADR 0056), and `PermissionManager` classified every `mcp_` tool as
`low` risk, which auto-allows in every mode, so under `ask` a server's tools could
write files, reach the network, or run commands without an approval card. The user
chose to launch the server, but its tool list comes from the server and can change
between versions, and server-annotated risk is a claim by the party being gated.

## Decision

Classify `mcp_` tools as `medium` risk, the same as a plugin tool without a valid
declaration. Under `ask` and `accept-edits` each call shows the approval card with
the reason "MCP server tool requires approval", where allow-once covers one call
and allow-session covers that exact tool name; `auto` runs without a card,
Plan/Goal keep denying it, and server-declared risk or annotations are ignored.
Dispatch over `plugins.execute`, read-only-mode handling, and the `mcp_` namespace
are unchanged, with no host protocol, schema, or persistence change.

## Consequences

- Users see an approval card for MCP tool calls in `ask` and `accept-edits` until
  they grant the tool for the session.
- A per-server or per-tool persistent allowlist, if wanted later, is a separate
  decision.

## Alternatives

- Trust server annotations: a server would be able to mark itself safe.
- Use `high` risk: it adds friction without a different settlement path.
