# ADR 0203: Local MCP Control Plane for Desktop Operations

- Status: Accepted
- Date: 2026-09-09
- Decision: D370 (amended by D372)

## Context

PI-Desktop has typed Electron-main IPC for projects, sessions, the agent,
workspace views, plugins, and settings, but only the renderer can reach it, so an
external Agent cannot drive a running desktop without a second
application-specific integration. The remote Gateway stays out of scope under
baseline decision #20 and ADR 0004.

## Decision

Add an optional Streamable HTTP MCP server inside Electron Main that starts only
with `PI_DESKTOP_MCP_CONTROL=1`, binds to `127.0.0.1` on `PI_DESKTOP_MCP_PORT`
(37123 by default), validates a supplied `Origin` against loopback hostnames, and
publishes its URL, bearer token, PID, and state in a mode-`0600`
`mcp-control.json` under the user-data directory. Every exposed call delegates to
the existing registered IPC handler, through named tools for the common
project/session/Agent/workspace flow plus a generic `pi_desktop_invoke` over a
risk-tagged catalog discovered by `pi_control_describe`. Dangerous generic
operations and named destructive tools, including `session/configure`, require
`confirm: true`, which is an agent acknowledgement rather than a user prompt.
Secret channels, provider/OAuth/MCP secret writes, settings writes, and
renderer-only picker channels are excluded, secret-shaped argument fields are
stripped, and a new IPC handler is never exposed automatically. Mutating
project, session, and Agent calls reuse `pi-desktop/session/event/changed` with
additive project and selection fields, while reads do not refresh the desktop.

## Consequences

- A local Agent can open a project, create or inspect sessions, send prompts,
  observe status, and invoke reviewed operations through a standard MCP client.
- Renderer and external Agent converge on the same IPC handlers and refresh
  path, so no authorization or persistence logic is duplicated.
- The endpoint grants the authority of the running desktop; loopback binding,
  opt-in startup, bearer authentication, and confirmation gates limit accidental
  exposure but not a process that can already read the token.
