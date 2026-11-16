# ADR 0038: Bridge plugin-declared MCP servers in Electron main

- Status: Accepted
- Date: 2026-07-31
- Related: [Plugin manifest schema](../spec/07-plugins/02-plugin-manifest-schema.md),
  [Plugin security](../spec/07-plugins/04-plugin-security.md),
  [ADR 0008](0008-plugin-runtime-isolation-target.md),
  [ADR 0142](0142-allow-non-loopback-http-mcp.md)

## Context

The plugin roadmap listed an "MCP plugin type" with nothing behind it. A plugin
that wanted to expose an MCP server's tools had to reimplement each one as a
plugin agent tool and proxy the traffic itself — duplicated work, and the
proxying happened in plugin code the host cannot inspect.

## Decision

1. MCP servers are **declared in the manifest**, never opened at runtime.
2. The two transports carry **separate permissions**: `mcp.server.local` for
   stdio, `mcp.server.remote` for HTTP.
3. The client lives in `apps/desktop/electron/main/plugin-mcp.ts` and speaks
   protocol `2025-06-18`: `initialize`, `tools/list`, `tools/call`.
4. Discovered tools register into the **existing** plugin tool map as
   `plugin_<pluginIdSafe>_<serverId>_<toolName>`, so no new routing exists
   anywhere between the model and the server.
5. Every discovered tool is registered at `risk: "medium"`.
6. Credentials resolve **only** from the plugin's own settings through `{
   "setting": "<key>" }` (D018).

## Consequences

- A plugin ships an MCP server as a manifest entry, and its tools appear to the
  agent with correct namespacing, auditing, and timeouts.
- Reviewing what a plugin can reach means reading its manifest: every endpoint
  and executable is declared text, not a runtime decision.
- Catalog size is a protocol guard, not a prompt budget: a server with 300 tools
  contributes all 300, because MCP tools reach the model as deferred on-demand
  entries behind `ToolSearch` and only the prompt block that advertises them is
  capped.
- Because MCP tools sit in the same map as hand-written plugin tools, disabling
  the plugin removes both, and a crashed plugin loses both.
- A remote server sees tool arguments.

## Alternatives

### stdio only

Rejected. Hosted MCP endpoints are common, and stdio-only would push plugin
authors to wrap them in a local shim process — an extra process plus an
unreviewable proxy, which is worse on both counts than a declared HTTP(S) URL.

### A separate `type: "mcp"` plugin kind

Rejected. It would need its own lifecycle, its own management UI, and its own
tool routing.

### Let the plugin process own the MCP connection

Rejected. The connection would then live behind the plugin's own code, outside
the broker's view, so the host could neither cap the tool set nor keep
credentials out of the plugin's reach.

### Trust the server's declared tool risk

Rejected. Risk drives host-core's confirmation flow.

## Amendment: stdio launcher resolution

GUI launches inherit a PATH that may not include fnm/nvm/uv shims. Windows `npx`
from the official Node installer is `npx.cmd` (plus a Git-Bash `npx` script),
which `spawn({ shell: false })` cannot start.
