# ADR 0203: Local MCP Control Plane for Desktop Operations

- Status: Accepted
- Date: 2026-09-09
- Decision: D370 (amended by D372)

## Context

PI-Desktop already has typed Electron-main IPC for projects, sessions, the pi
Agent, workspace views, plugins, settings, and other desktop operations. That
surface is available to the renderer only, so an external Agent cannot drive a
running desktop without a second application-specific integration.

## Decision

- Add an optional Streamable HTTP MCP server inside Electron Main.
- Validate any supplied `Origin` against loopback hostnames to prevent DNS
  rebinding from remote web content.
- Persist a random 256-bit bearer token in the Electron user-data directory and
  publish the current URL, token, PID, and active state in `mcp-control.json`.
- Delegate every exposed call to the existing registered main-process IPC
  handler.
- Require `confirm: true` for dangerous generic operations and destructive named
  tools, including `session/configure` (permission mode).
- Bind only loopback addresses; `initialize` negotiates `2025-06-18` or the
  compatible `2025-03-26` value and never echoes an unsupported version.
- After successful **mutating** project/session/Agent calls, reuse the existing
  `pi-desktop/session/event/changed` renderer event with additive project and
  selection fields.

## Consequences

An external local Agent can open a project, create or inspect sessions, send a
prompt, observe status, and invoke reviewed desktop operations through a
standard MCP client.

The endpoint grants a local client the authority of the running desktop for the
operations it invokes.

## Amendment (D372)

Narrow the first-version catalog to the project/session/Agent/workspace flow
plus reviewed reads. `session/configure` is dangerous because it can set
`permissionMode: "auto"`.
