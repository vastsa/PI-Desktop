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

Two constraints shape the design. First, the agent already has a working path
for plugin tools: `plugin_<pluginIdSafe>_<toolName>` flows from the model through
the sidecar to host-core's permission gate and back out to Electron main
(`07-plugins/12` appendix). Anything that reuses that path inherits the timeout,
the audit trail, and the per-plugin disable switch for free. Second, MCP servers
are two very different things wearing one name: a local executable we spawn, and
a remote endpoint we send arguments to. They fail differently and they leak
differently.

## Decision

1. MCP servers are **declared in the manifest**, never opened at runtime.
   `contributes.mcpServers` carries `{ id, label?, transport }` plus exactly one
   transport's fields — `stdio` uses `command` / `args` / `env`, `http` uses
   `url` / `headers`. A manifest that mixes them fails validation in both
   host-core and the SDK validator.
2. The two transports carry **separate permissions**: `mcp.server.local` for
   stdio, `mcp.server.remote` for HTTP. Running a local binary and shipping tool
   arguments to a third party are different consents, so the permission copy
   states each plainly.
3. The client lives in `apps/desktop/electron/main/plugin-mcp.ts` and speaks
   protocol `2025-06-18`: `initialize`, `tools/list`, `tools/call`. Framing is
   NDJSON over stdio pipes, or streamable HTTP with SSE responses. Budgets: 10s
   to complete the handshake, 100s per call (under the 110s plugin tool budget,
   itself under host-core's 120s), 8 `tools/list` pages, 4MB per stdio line, 64
   tools per server, 8 servers per plugin. Connection is lazy — declaring a
   server costs nothing until a tool is called — and teardown follows unload.
4. Discovered tools register into the **existing** plugin tool map as
   `plugin_<pluginIdSafe>_<serverId>_<toolName>`, so no new routing exists
   anywhere between the model and the server.
5. Every discovered tool is registered at `risk: "medium"`. The name, schema,
   and description come from a third-party server; a self-declared risk level
   from that source is not evidence.
6. Credentials resolve **only** from the plugin's own settings through
   `{ "setting": "<key>" }` (D018). A stdio child receives `PATH`, temp/locale
   variables, `PI_PLUGIN_ID`, and the declared values — not the host
   environment, which holds provider keys. `command` must be a bare PATH name or
   stay inside the plugin directory; `url` may use `http` or `https`, with
   non-loopback HTTP subject to ADR 0142 and the plugin network allowlist.

## Consequences

- A plugin ships an MCP server as a manifest entry, and its tools appear to the
  agent with correct namespacing, auditing, and timeouts.
- Reviewing what a plugin can reach means reading its manifest: every endpoint
  and executable is declared text, not a runtime decision.
- The tool cap and the page cap are silent truncations by design — a server with
  200 tools contributes 64 and logs the drop rather than flooding the prompt.
- Because MCP tools sit in the same map as hand-written plugin tools, disabling
  the plugin removes both, and a crashed plugin loses both.
- A remote server sees tool arguments. No amount of host-side care changes that;
  the permission and its copy exist so the user decides.

## Alternatives

### stdio only

Rejected. Hosted MCP endpoints are common, and stdio-only would push plugin
authors to wrap them in a local shim process — an extra process plus an
unreviewable proxy, which is worse on both counts than a declared HTTP(S) URL.

### A separate `type: "mcp"` plugin kind

Rejected. It would need its own lifecycle, its own management UI, and its own
tool routing. A contribution point on the existing plugin type reuses install,
enable/disable, permissions, and audit as they are.

### Let the plugin process own the MCP connection

Rejected. The connection would then live behind the plugin's own code, outside
the broker's view, so the host could neither cap the tool set nor keep
credentials out of the plugin's reach.

### Trust the server's declared tool risk

Rejected. Risk drives host-core's confirmation flow. A value chosen by the
inspected party cannot gate the inspection.
