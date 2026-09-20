import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MCP_PROTOCOL_VERSION,
  McpServerClient,
  describeMcpContent,
  mcpProcessEnv,
  resolveMcpCommand,
} from "../electron/main/plugin-mcp.ts";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const runtimeSrc = readFileSync(join(desktopRoot, "electron/main/plugin-runtime.ts"), "utf8");

/**
 * A stdio MCP server that answers the slice of the protocol the desktop uses.
 * It deliberately prints one non-JSON line and paginates `tools/list` so the
 * client's framing and cursor handling are exercised for real.
 */
const STDIO_SERVER = `
import { writeFileSync } from "node:fs";
writeFileSync(process.env.STUB_PID_FILE, String(process.pid));
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
const text = (id, value, isError) =>
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) } });
let roundtripId = null;
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
    index = buffer.indexOf("\\n");
  }
});
function handle(msg) {
  if (msg.method === "initialize") {
    // Servers that log to stdout are common; the client must tolerate it.
    process.stdout.write("stub server ready\\n");
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stub", version: "1" } },
    });
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    if (!msg.params || !msg.params.cursor) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          tools: [
            { name: "echo", description: "Echo the text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
            { name: "" },
          ],
          nextCursor: "page-2",
        },
      });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "env" }, { name: "roundtrip" }, { name: "boom" }] } });
    }
    return;
  }
  if (msg.method === "tools/call") {
    const name = msg.params.name;
    if (name === "echo") return text(msg.id, String(msg.params.arguments.text));
    if (name === "env") {
      return text(msg.id, [process.env.PI_PLUGIN_ID, process.env.STUB_TOKEN, process.env.PI_LEAKED_SECRET ?? "absent"].join("|"));
    }
    if (name === "roundtrip") {
      roundtripId = msg.id;
      return send({ jsonrpc: "2.0", id: 990, method: "sampling/createMessage", params: {} });
    }
    return text(msg.id, "the tool refused", true);
  }
  if (msg.id === 990 && msg.error && roundtripId !== null) {
    text(roundtripId, "client replied: " + msg.error.code);
    roundtripId = null;
    return;
  }
  if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown method" } });
}
`;

function stdioPlugin() {
  const dir = mkdtempSync(join(tmpdir(), "pi-mcp-stdio-"));
  writeFileSync(join(dir, "server.mjs"), STDIO_SERVER);
  return dir;
}

test("a stdio mcp server is handshaken, paginated and callable", async (t) => {
  const dir = stdioPlugin();
  const pidFile = join(dir, "pid");
  const audits = [];
  const client = new McpServerClient({
    pluginId: "com.example.mcp",
    rootPath: dir,
    server: { id: "stub", label: "Stub", transport: "stdio", command: "node", args: ["./server.mjs"] },
    values: { STUB_TOKEN: "t0ken", STUB_PID_FILE: pidFile },
    audit: (entry) => audits.push(entry),
    connectTimeoutMs: 5_000,
    callTimeoutMs: 5_000,
  });
  t.after(() => client.close());

  const tools = await client.connect();
  // Both pages are merged and the nameless entry is dropped.
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["echo", "env", "roundtrip", "boom"],
  );
  assert.equal(tools[0].description, "Echo the text back");
  assert.deepEqual(tools[0].inputSchema, {
    type: "object",
    properties: { text: { type: "string" } },
  });
  assert.equal(client.isConnected(), true);

  const echoed = await client.callTool("echo", { text: "hello mcp" });
  assert.equal(describeMcpContent(echoed.content), "hello mcp");

  const connect = audits.find((entry) => entry.api === "plugin.mcp.connect");
  assert.equal(connect.ok, true);
  assert.equal(connect.transport, "stdio");
  assert.equal(connect.toolCount, 4);
  const call = audits.find((entry) => entry.api === "plugin.mcp.call");
  assert.equal(call.ok, true);
  assert.equal(call.tool, "echo");
  assert.equal(typeof call.durationMs, "number");
});

test("a stdio server only sees the values the plugin declared", async (t) => {
  const dir = stdioPlugin();
  process.env.PI_LEAKED_SECRET = "must-not-cross";
  t.after(() => {
    delete process.env.PI_LEAKED_SECRET;
  });
  const client = new McpServerClient({
    pluginId: "com.example.mcp",
    rootPath: dir,
    server: { id: "stub", transport: "stdio", command: "node", args: ["./server.mjs"] },
    values: { STUB_TOKEN: "t0ken", STUB_PID_FILE: join(dir, "pid") },
    connectTimeoutMs: 5_000,
    callTimeoutMs: 5_000,
  });
  t.after(() => client.close());
  await client.connect();
  const result = await client.callTool("env", {});
  assert.equal(describeMcpContent(result.content), "com.example.mcp|t0ken|absent");
});

test("an mcp tool error surfaces as TOOL_FAILED and is audited", async (t) => {
  const dir = stdioPlugin();
  const audits = [];
  const client = new McpServerClient({
    pluginId: "com.example.mcp",
    rootPath: dir,
    server: { id: "stub", transport: "stdio", command: "node", args: ["./server.mjs"] },
    values: { STUB_PID_FILE: join(dir, "pid") },
    audit: (entry) => audits.push(entry),
    connectTimeoutMs: 5_000,
    callTimeoutMs: 5_000,
  });
  t.after(() => client.close());
  await client.connect();
  await assert.rejects(client.callTool("boom", {}), (error) => {
    assert.equal(error.code, "TOOL_FAILED");
    assert.match(error.message, /the tool refused/);
    return true;
  });
  const failed = audits.find((entry) => entry.api === "plugin.mcp.call" && entry.ok === false);
  assert.equal(failed.errorCode, "TOOL_FAILED");
});

test("a server-initiated request is refused instead of ignored", async (t) => {
  const dir = stdioPlugin();
  const client = new McpServerClient({
    pluginId: "com.example.mcp",
    rootPath: dir,
    server: { id: "stub", transport: "stdio", command: "node", args: ["./server.mjs"] },
    values: { STUB_PID_FILE: join(dir, "pid") },
    connectTimeoutMs: 5_000,
    callTimeoutMs: 5_000,
  });
  t.after(() => client.close());
  await client.connect();
  const result = await client.callTool("roundtrip", {});
  assert.equal(describeMcpContent(result.content), "client replied: -32601");
});

test("closing the client kills the stdio child", async () => {
  const dir = stdioPlugin();
  const pidFile = join(dir, "pid");
  const client = new McpServerClient({
    pluginId: "com.example.mcp",
    rootPath: dir,
    server: { id: "stub", transport: "stdio", command: "node", args: ["./server.mjs"] },
    values: { STUB_PID_FILE: pidFile },
    connectTimeoutMs: 5_000,
    callTimeoutMs: 5_000,
  });
  await client.connect();
  const pid = Number(readFileSync(pidFile, "utf8"));
  client.close();
  assert.equal(client.isConnected(), false);
  assert.deepEqual(client.getTools(), []);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail("stdio mcp child survived close()");
});

test("a stdio server that cannot start fails the handshake, not the process", async () => {
  const dir = stdioPlugin();
  const audits = [];
  const client = new McpServerClient({
    pluginId: "com.example.mcp",
    rootPath: dir,
    server: { id: "stub", transport: "stdio", command: "node", args: ["./missing-server.mjs"] },
    values: {},
    audit: (entry) => audits.push(entry),
    connectTimeoutMs: 5_000,
  });
  await assert.rejects(client.connect());
  assert.equal(client.isConnected(), false);
  const failure = audits.find((entry) => entry.api === "plugin.mcp.connect" && entry.ok === false);
  assert.equal(failure.serverId, "stub");
  assert.match(String(failure.message), /exited with code/);
});

test("a slow server times out instead of hanging the load", async (t) => {
  const dir = stdioPlugin();
  writeFileSync(join(dir, "server.mjs"), "setInterval(() => {}, 1000);\n");
  const client = new McpServerClient({
    pluginId: "com.example.mcp",
    rootPath: dir,
    server: { id: "stub", transport: "stdio", command: "node", args: ["./server.mjs"] },
    values: {},
    connectTimeoutMs: 250,
  });
  t.after(() => client.close());
  await assert.rejects(client.connect(), (error) => {
    assert.equal(error.code, "TIMEOUT");
    return true;
  });
});

/** Streamable-HTTP stub: JSON for the handshake, SSE for discovery. */
async function startHttpServer(t) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      requests.push({ headers: req.headers, message });
      if (message.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-42" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: message.params.protocolVersion, capabilities: {} },
          }),
        );
        return;
      }
      if (message.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      if (message.method === "tools/list") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          `event: message\ndata: ${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { tools: [{ name: "headers" }] },
          })}\n\n`,
        );
        return;
      }
      if (message.params?.name === "headers") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [
                {
                  type: "text",
                  text: `${req.headers["mcp-session-id"]}|${req.headers["x-api-key"]}|${req.headers["mcp-protocol-version"]}`,
                },
              ],
            },
          }),
        );
        return;
      }
      res.writeHead(503).end("unavailable");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, requests };
}

test("a remote mcp server negotiates over http and keeps its session", async (t) => {
  const { url, requests } = await startHttpServer(t);
  const client = new McpServerClient({
    pluginId: "com.example.remote",
    rootPath: mkdtempSync(join(tmpdir(), "pi-mcp-http-")),
    server: { id: "remote", transport: "http", url },
    values: { "x-api-key": "sk-test" },
    connectTimeoutMs: 5_000,
    callTimeoutMs: 5_000,
  });
  t.after(() => client.close());

  const tools = await client.connect();
  assert.deepEqual(
    tools.map((tool) => tool.name),
    ["headers"],
  );
  const result = await client.callTool("headers", {});
  assert.equal(describeMcpContent(result.content), `sess-42|sk-test|${MCP_PROTOCOL_VERSION}`);
  // The very first request cannot carry a session id, later ones must.
  assert.equal(requests[0].headers["mcp-session-id"], undefined);
  assert.equal(requests[0].headers["x-api-key"], "sk-test");
  assert.equal(requests.at(-1).headers["mcp-session-id"], "sess-42");
});

test("an http failure is reported as HTTP_ERROR", async (t) => {
  const { url } = await startHttpServer(t);
  const client = new McpServerClient({
    pluginId: "com.example.remote",
    rootPath: mkdtempSync(join(tmpdir(), "pi-mcp-http-")),
    server: { id: "remote", transport: "http", url },
    values: {},
    connectTimeoutMs: 5_000,
    callTimeoutMs: 5_000,
  });
  t.after(() => client.close());
  await client.connect();
  await assert.rejects(client.callTool("nope", {}), (error) => {
    assert.equal(error.code, "HTTP_ERROR");
    assert.match(error.message, /503/);
    return true;
  });
});

test("an http redirect is rechecked before the next MCP request", async (t) => {
  const requests = [];
  const client = new McpServerClient({
    pluginId: "com.example.remote",
    rootPath: mkdtempSync(join(tmpdir(), "pi-mcp-http-")),
    server: { id: "remote", transport: "http", url: "http://mcp.example.test/mcp" },
    values: {},
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(null, {
        status: 302,
        headers: { location: "http://other.example.test/mcp" },
      });
    },
    assertUrlAllowed: (url) => {
      if (new URL(url).hostname !== "mcp.example.test") {
        throw new Error(`endpoint not allowed: ${url}`);
      }
    },
    connectTimeoutMs: 5_000,
    callTimeoutMs: 5_000,
  });
  t.after(() => client.close());

  await assert.rejects(client.connect(), /endpoint not allowed/);
  assert.equal(requests.length, 1, "the redirected endpoint was not contacted");
  assert.equal(requests[0].options.redirect, "manual");
});

test("cross-origin mcp redirects do not forward credentials or session ids", async (t) => {
  const requests = [];
  const client = new McpServerClient({
    pluginId: "com.example.remote",
    rootPath: mkdtempSync(join(tmpdir(), "pi-mcp-http-")),
    server: { id: "remote", transport: "http", url: "http://first.example.test/mcp" },
    values: {
      Authorization: "Bearer secret",
      Cookie: "session=secret",
      "x-api-key": "secret",
      "x-safe": "keep",
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (requests.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://second.example.test/mcp" },
        });
      }
      const message = JSON.parse(options.body);
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (message.method === "tools/list") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "sess-1" },
      });
    },
    assertUrlAllowed: () => {},
    connectTimeoutMs: 5_000,
  });
  t.after(() => client.close());
  await client.connect();
  assert.equal(requests.length, 4);
  assert.equal(requests[0].options.headers.Authorization, "Bearer secret");
  assert.equal(requests[1].options.headers.Authorization, undefined);
  assert.equal(requests[1].options.headers.Cookie, undefined);
  assert.equal(requests[1].options.headers["x-api-key"], undefined);
  assert.equal(requests[1].options.headers["x-safe"], undefined);
  assert.equal(requests[1].options.headers["mcp-session-id"], undefined);
});

test("an oversized remote mcp response fails closed", async (t) => {
  const client = new McpServerClient({
    pluginId: "com.example.remote",
    rootPath: mkdtempSync(join(tmpdir(), "pi-mcp-http-")),
    server: { id: "remote", transport: "http", url: "http://mcp.example.test/mcp" },
    values: {},
    fetchImpl: async () =>
      new Response("x".repeat(4 * 1024 * 1024 + 1), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    connectTimeoutMs: 5_000,
  });
  t.after(() => client.close());
  await assert.rejects(client.connect(), (error) => {
    assert.equal(error.code, "LIMIT_EXCEEDED");
    return true;
  });
  assert.equal(client.isConnected(), false);
});

test("the stdio environment carries no host secrets", () => {
  process.env.PI_LEAKED_SECRET = "must-not-cross";
  try {
    const env = mcpProcessEnv("com.example.mcp", { TOKEN: "t0ken" });
    assert.equal(env.PI_PLUGIN_ID, "com.example.mcp");
    assert.equal(env.TOKEN, "t0ken");
    assert.equal(env.PI_LEAKED_SECRET, undefined);
    // PATH still crosses, or a bare command name could never be found.
    assert.ok(typeof env.PATH === "string" && env.PATH.length > 0);
    for (const part of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
      assert.ok(env.PATH.split(delimiter).includes(part), part);
    }
  } finally {
    delete process.env.PI_LEAKED_SECRET;
  }
});

test("stdio PATH uses the login-shell lookup and names a missing command", () => {
  const src = readFileSync(join(desktopRoot, "electron/main/plugin-mcp.ts"), "utf8");
  assert.match(src, /import \{ userLookupPath \} from "\.\/user-login-path\.ts"/);
  assert.match(src, /userLookupPath\(process\.env\.PATH/);
  assert.match(src, /command not found: \$\{options\.command\}/);
});

test("a command may not escape the plugin directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-mcp-cmd-"));
  assert.equal(resolveMcpCommand(dir, "node"), "node");
  assert.equal(resolveMcpCommand(dir, "./bin/server"), join(dir, "bin/server"));
  assert.throws(() => resolveMcpCommand(dir, "../outside/server"), /escapes the plugin directory/);
});

test("the runtime gates mcp servers on their transport permission", () => {
  const register = runtimeSrc.slice(
    runtimeSrc.indexOf("private async registerMcpServers"),
    runtimeSrc.indexOf("private skipMcpServer"),
  );
  assert.match(register, /validateMcpServer\(raw\)/);
  assert.match(register, /"mcp\.server\.local"/);
  assert.match(register, /"mcp\.server\.remote"/);
  assert.match(register, /assertUrlAllowed/);
  assert.match(register, /plugin\.mcp\.redirect/);
  assert.match(register, /PERMISSION_DENIED/);
  assert.match(runtimeSrc, /MAX_MCP_SERVERS_PER_PLUGIN = 8/);
  // Credentials come from the plugin's own settings, never the host env.
  assert.match(register, /plugin\.getSettings\(\)/);
  assert.match(register, /resolveMcpRefs\(/);
  assert.match(register, /CONFIG_MISSING/);
});

test("discovered mcp tools ride the existing plugin tool path", () => {
  const register = runtimeSrc.slice(
    runtimeSrc.indexOf("private async registerMcpServers"),
    runtimeSrc.indexOf("private skipMcpServer"),
  );
  assert.match(register, /pluginMcpToolKey\(server\.id, tool\.name\)/);
  assert.match(register, /pluginToolName\(pluginId, name\)/);
  assert.match(register, /this\.tools\.set\(fullName/);
  // Remote code the desktop cannot inspect never auto-approves.
  assert.match(register, /risk: "medium"/);
  assert.match(register, /client\.callTool\(tool\.name, toolArgs\)/);
  // A server that fails to answer must not fail the plugin load.
  assert.match(register, /await client\.connect\(\);\s*\n\s*\} catch \{/);
});

test("mcp clients are closed when the plugin goes away", () => {
  const clear = runtimeSrc.slice(
    runtimeSrc.indexOf("private clearContributions"),
    runtimeSrc.indexOf("private registerSkills"),
  );
  assert.match(clear, /this\.mcpClients\.get\(pluginId\)/);
  assert.match(clear, /client\.close\(\)/);
  assert.match(clear, /this\.mcpClients\.delete\(pluginId\)/);
});

/**
 * A catalog stub whose size, page shape, cursor behaviour, and per-page delay
 * come from the test, so the client's catalog guards run through real stdio
 * framing rather than a hand-built result object.
 */
const CATALOG_SERVER = `
import { writeFileSync } from "node:fs";
if (process.env.STUB_PID_FILE) writeFileSync(process.env.STUB_PID_FILE, String(process.pid));
const NL = String.fromCharCode(10);
const total = Number(process.env.STUB_TOOL_COUNT ?? "0");
const pageSize = Number(process.env.STUB_PAGE_SIZE ?? "100");
const cursorMode = process.env.STUB_CURSOR_MODE ?? "advance";
const pageDelayMs = Number(process.env.STUB_PAGE_DELAY_MS ?? "0");
const send = (msg) => process.stdout.write(JSON.stringify(msg) + NL);
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf(NL);
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
    index = buffer.indexOf(NL);
  }
});
function nextCursorFor(page, start) {
  if (cursorMode === "repeat") return "page-1";
  if (cursorMode === "loop") return page === 1 ? "page-2" : "page-1";
  if (cursorMode === "bogus") return 7;
  if (cursorMode === "always") return "page-" + (page + 1);
  return start + pageSize < total ? "page-" + (page + 1) : undefined;
}
function handle(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "catalog", version: "1" } } });
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    const cursor = msg.params && msg.params.cursor ? String(msg.params.cursor) : "";
    const page = cursor ? Number(cursor.replace("page-", "")) : 0;
    const start = page * pageSize;
    const reply = () => {
      const tools = [];
      for (let i = start; i < Math.min(start + pageSize, total); i += 1) {
        tools.push({ name: "tool_" + i, description: "Tool " + i, inputSchema: { type: "object", properties: {} } });
      }
      const nextCursor = nextCursorFor(page, start);
      send({ jsonrpc: "2.0", id: msg.id, result: { tools, ...(nextCursor ? { nextCursor } : {}) } });
    };
    if (pageDelayMs > 0) setTimeout(reply, pageDelayMs);
    else reply();
    return;
  }
  if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown method" } });
}
`;

function catalogClient(t, values, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-mcp-catalog-"));
  writeFileSync(join(dir, "server.mjs"), CATALOG_SERVER);
  const pidFile = join(dir, "pid");
  const audits = [];
  const client = new McpServerClient({
    pluginId: "com.example.mcp",
    rootPath: dir,
    server: { id: "catalog", label: "Catalog", transport: "stdio", command: "node", args: ["./server.mjs"] },
    values: { STUB_PID_FILE: pidFile, ...values },
    audit: (entry) => audits.push(entry),
    connectTimeoutMs: 5_000,
    callTimeoutMs: 5_000,
    ...extra,
  });
  t.after(() => client.close());
  return { client, audits, pidFile };
}

test("a catalog larger than the old per-server cap is discovered whole", async (t) => {
  const { client, audits } = catalogClient(t, {
    STUB_TOOL_COUNT: "300",
    STUB_PAGE_SIZE: "100",
  });
  const tools = await client.connect();
  // The old cap dropped everything past the 64th tool of the first pages.
  assert.equal(tools.length, 300);
  assert.equal(tools[0].name, "tool_0");
  assert.equal(tools[64].name, "tool_64");
  assert.equal(tools[299].name, "tool_299");
  assert.equal(tools[299].description, "Tool 299");
  assert.equal(client.getTools().length, 300);
  const connect = audits.find((entry) => entry.api === "plugin.mcp.connect");
  assert.equal(connect.ok, true);
  assert.equal(connect.toolCount, 300);
  assert.equal(
    audits.some((entry) => entry.api === "plugin.mcp.tools.truncated"),
    false,
  );
});

test("a catalog over the protocol ceiling refuses the server instead of truncating", async (t) => {
  const { client, audits } = catalogClient(t, {
    STUB_TOOL_COUNT: "2049",
    STUB_PAGE_SIZE: "2048",
  });
  await assert.rejects(client.connect(), { code: "LIMIT_EXCEEDED" });
  // A refused handshake contributes no tools at all, never a prefix.
  assert.equal(client.isConnected(), false);
  assert.deepEqual(client.getTools(), []);
  const connect = audits.filter((entry) => entry.api === "plugin.mcp.connect").pop();
  assert.equal(connect.ok, false);
  assert.equal(connect.errorCode, "LIMIT_EXCEEDED");
  assert.match(connect.message, /2048 tools/);
});

test("a repeated tools/list cursor refuses the server", async (t) => {
  const { client, audits } = catalogClient(t, {
    STUB_TOOL_COUNT: "10",
    STUB_PAGE_SIZE: "5",
    STUB_CURSOR_MODE: "repeat",
  });
  await assert.rejects(client.connect(), { code: "INVALID_RESPONSE" });
  assert.equal(client.isConnected(), false);
  const connect = audits.filter((entry) => entry.api === "plugin.mcp.connect").pop();
  assert.equal(connect.ok, false);
  assert.match(connect.message, /repeated a tools\/list cursor/);
});

test("a tools/list cursor that loops back to an earlier page refuses the server", async (t) => {
  const { client, audits } = catalogClient(t, {
    STUB_TOOL_COUNT: "30",
    STUB_PAGE_SIZE: "5",
    STUB_CURSOR_MODE: "loop",
  });
  await assert.rejects(client.connect(), { code: "INVALID_RESPONSE" });
  assert.equal(client.isConnected(), false);
  const connect = audits.filter((entry) => entry.api === "plugin.mcp.connect").pop();
  assert.match(connect.message, /repeated a tools\/list cursor/);
});

test("a server that never stops paginating is refused at the page ceiling", async (t) => {
  const { client, audits } = catalogClient(t, {
    STUB_TOOL_COUNT: "1",
    STUB_PAGE_SIZE: "1",
    STUB_CURSOR_MODE: "always",
  });
  await assert.rejects(client.connect(), { code: "LIMIT_EXCEEDED" });
  const connect = audits.filter((entry) => entry.api === "plugin.mcp.connect").pop();
  assert.match(connect.message, /100 pages/);
});

test("a catalog that cannot be listed inside its discovery budget is refused", async (t) => {
  // Budget already spent before the first page: the guard trips immediately.
  const spent = catalogClient(t, { STUB_TOOL_COUNT: "10", STUB_PAGE_SIZE: "5" }, {
    discoveryTimeoutMs: 0,
  });
  await assert.rejects(spent.client.connect(), { code: "TIMEOUT" });
  assert.equal(spent.client.isConnected(), false);

  // A slow catalog crosses the budget mid-traversal instead.
  const slow = catalogClient(
    t,
    { STUB_TOOL_COUNT: "100", STUB_PAGE_SIZE: "10", STUB_PAGE_DELAY_MS: "40" },
    { discoveryTimeoutMs: 45 },
  );
  await assert.rejects(slow.client.connect(), { code: "TIMEOUT" });
  assert.equal(slow.client.isConnected(), false);
});

test("a catalog cursor that is not a string refuses the server", async (t) => {
  const { client, audits } = catalogClient(t, {
    STUB_TOOL_COUNT: "10",
    STUB_PAGE_SIZE: "5",
    STUB_CURSOR_MODE: "bogus",
  });
  // A malformed cursor must not read as "that was the last page".
  await assert.rejects(client.connect(), { code: "INVALID_RESPONSE" });
  assert.deepEqual(client.getTools(), []);
  const connect = audits.filter((entry) => entry.api === "plugin.mcp.connect").pop();
  assert.match(connect.message, /non-string tools\/list cursor/);
});

test("a refused catalog kills the stdio child instead of leaving it behind", async (t) => {
  const { client, pidFile } = catalogClient(t, {
    STUB_TOOL_COUNT: "10",
    STUB_PAGE_SIZE: "5",
    STUB_CURSOR_MODE: "repeat",
  });
  await assert.rejects(client.connect(), { code: "INVALID_RESPONSE" });
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 0, "stub did not report its pid");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail("stdio mcp child survived a refused handshake");
});
