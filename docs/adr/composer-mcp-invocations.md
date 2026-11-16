# ADR: Composer MCP Invocations

- Status: Accepted
- Date: 2026-10-04
- Related: #1377, ADR 0024, ADR 0219

## Context

Explicit MCP selection belongs in the composer alongside Skills and plugin
commands. Tool discovery, argument selection, execution and approval remain
owned by the runtime and Host.

## Decision

Catalog discovery refreshes enabled user MCP records and uses the runtime's
existing bounded connection path, including before the first session after
restart. The composer exposes ready servers with tools in the current project.

Main revalidates the selection against the session project's current catalog on
prompt or steering submission. It preserves the typed text in `command`, adds a
short model-facing selection instruction, and forwards `mcpServerIds` and
optional `mcpToolNames` through internal RPC.

## Consequences and alternatives

The optional catalog and internal RPC fields reuse the existing execution path
without database, Plugin SDK or Host protocol changes.

Selection makes tools available but does not force execution.

## Unreleased user-facing change

Select a connected MCP server or one of its tools from the composer's `/` menu
and send a task. Existing tool approvals still apply.
