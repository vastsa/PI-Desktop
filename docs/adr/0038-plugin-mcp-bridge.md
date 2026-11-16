# ADR 0038: Bridge plugin-declared MCP servers in Electron main

- Status: Accepted
- Date: 2026-07-31
- Related: [Plugin manifest schema](../spec/07-plugins/02-plugin-manifest-schema.md), [Plugin security](../spec/07-plugins/04-plugin-security.md), [ADR 0008](0008-plugin-runtime-isolation-target.md), [ADR 0142](0142-allow-non-loopback-http-mcp.md)

## Context

The plugin roadmap listed an "MCP plugin type" with nothing behind it, so a plugin
that wanted an MCP server's tools had to reimplement each one as a plugin agent
tool and proxy the traffic inside plugin code the host cannot inspect. The agent
already routes plugin tools through the permission gate and audit path, and MCP
servers are two different things under one name: a local executable we spawn and a
remote endpoint we send arguments to, which fail and leak differently.

## Decision

1. MCP servers are declared in the manifest, never opened at runtime:
   `contributes.mcpServers` carries `{ id, label?, transport }` plus exactly one
   transport's fields, `command` / `args` / `env` for `stdio` or `url` / `headers`
   for `http`, and a manifest that mixes them fails validation in both host-core
   and the SDK validator.
2. The transports carry separate permissions, `mcp.server.local` for stdio and
   `mcp.server.remote` for HTTP, because running a local binary and shipping
   arguments to a third party are different consents.
3. The client lives in Electron main and speaks MCP `2025-06-18` through
   `initialize`, `tools/list`, and `tools/call`, using NDJSON over stdio pipes or
   streamable HTTP with SSE responses. Handshake, call, line, server-count,
   tool-count, page, and traversal budgets are bounded, and a server that breaks a
   bound is refused rather than truncated; host-core's dispatch deadline covers the
   whole leg, so the client reports its own timeout first. Connections are lazy and
   teardown follows unload.
4. Discovered tools register into the existing plugin tool map as
   `plugin_<pluginIdSafe>_<serverId>_<toolName>`, so no new routing exists between
   the model and the server.
5. Every discovered tool registers at `risk: "medium"`, because a risk level
   declared by the inspected third-party server is not evidence.
6. Credentials resolve only from the plugin's own settings through
   `{ "setting": "<key>" }` (D018). A stdio child receives the declared values,
   `PI_PLUGIN_ID`, and a fixed set of temp, locale, and toolchain variables rather
   than the host environment that holds provider keys, with the Unix PATH taken
   from the login shell (D600). Bare `npx` / `uvx` resolve to real binaries, and a
   Windows bare `python` skips the Microsoft Store alias (D624, issue #789).
   `command` must be a bare PATH name or stay inside the plugin directory, and
   `url` may use `http` or `https`, with non-loopback HTTP subject to ADR 0142 and
   the plugin network allowlist.

## Consequences

- A plugin ships an MCP server as a manifest entry, and its tools reach the agent
  with correct namespacing, auditing, and timeouts.
- Reviewing what a plugin can reach means reading its manifest, where every
  endpoint and executable is declared text rather than a runtime decision.
- Catalog size is a protocol guard, not a prompt budget, because MCP tools reach
  the model as deferred on-demand entries behind `ToolSearch`.
- Disabling or crashing the plugin removes its MCP tools as well, and a remote
  server still sees every argument sent to it.

## Alternatives

- stdio only: rejected, hosted endpoints are common and would push authors into
  extra local shim processes the host cannot review.
- A separate `type: "mcp"` plugin kind: rejected, it would duplicate lifecycle,
  management UI, and tool routing.
- Let the plugin process own the connection: rejected, the host could then neither
  cap the tool set nor keep credentials out of the plugin's reach.
