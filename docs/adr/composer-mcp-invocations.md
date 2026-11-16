# ADR: Composer MCP Invocations

- Status: Accepted
- Date: 2026-10-04
- Related: #1377, ADR 0024, ADR 0219

## Context

Explicit MCP selection belongs in the composer beside Skills and plugin commands,
while tool discovery, argument selection, execution, and approval stay owned by
the runtime and Host.

## Decision

Catalog discovery refreshes enabled user MCP records through the runtime's
existing bounded connection path, and the composer exposes ready servers with
tools in the current project as `/mcp:<URI-encoded-server-id>` entries, appending
`:<URI-encoded-tool-name>` for a single tool. Entries carry `kind: "mcp"`,
`mcpServerId`, and an optional `mcpToolName`, existing command aliases keep
precedence, selecting an entry inserts text without connecting or executing, and
credentials and tool schemas stay out of the catalog.

Main revalidates the selection against the session project's catalog on prompt or
steering submission, adds a short model-facing selection instruction, and
forwards `mcpServerIds` and optional `mcpToolNames` through internal RPC. Server
selection activates every mode-allowed tool of that server, tool selection
activates only the requested tools after ownership and mode checks, and neither
removes tools already active; an unavailable selection fails explicitly instead
of becoming prompt text.

## Consequences

- The optional catalog and internal RPC fields reuse the existing execution path
  with no database, Plugin SDK, or Host protocol change.
- Selection makes tools available without forcing execution, and Main rejects a
  selection with no task text or attachment before opening a turn.

## Alternatives

- Have the renderer drive the tool call: rejected; it would duplicate runtime
  argument selection and permission handling.
