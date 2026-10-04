import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IPC } from "@pi-desktop/shared";
import { registerMcpIpc } from "../electron/main/ipc/mcp-ipc.ts";
import { UserMcpRuntime, configurationChanged, reconnectAuthorizedMcp } from "../electron/main/user-mcp.ts";
import { McpServerClient } from "../electron/main/plugin-mcp.ts";

/**
 * A stdio MCP server small enough to read: it answers the handshake, advertises
 * two tools, and echoes back the argument it was given plus the name it was
 * started under, so a test can prove which process served a call.
 */
const STUB = `
import { writeFileSync } from "node:fs";
if (process.env.STUB_PID_FILE) writeFileSync(process.env.STUB_PID_FILE, String(process.pid));
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
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
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} } } });
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [{ name: process.env.STUB_TOOL_NAME ?? "lookup", description: "Look something up" }, { name: "ping" }],
        // A server that keeps handing back the same cursor can never be listed
        // to its last page, so the client has to refuse it.
        ...(process.env.STUB_REPEAT_CURSOR ? { nextCursor: "more" } : {}),
      },
    });
    return;
  }
  if (msg.method === "tools/call") {
    const tag = process.env.STUB_TAG ?? "untagged";
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: tag + ":" + msg.params.name }] },
    });
    return;
  }
  if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } });
}
`;

function stubDir() {
  const dir = mkdtempSync(join(tmpdir(), "pi-user-mcp-"));
  writeFileSync(join(dir, "server.mjs"), STUB);
  return dir;
}

/** A saved record for the stub, scoped globally unless told otherwise. */
function stubRecord(dir, overrides = {}) {
  return {
    id: "stub",
    label: "Stub",
    transport: "stdio",
    command: "node",
    args: [join(dir, "server.mjs")],
    env: {},
    enabled: true,
    scope: { mode: "global", projects: [] },
    ...overrides,
  };
}

function runtime(t, options = {}) {
  const { spawnImpl, ...rest } = options;
  const instance = new UserMcpRuntime({
    createClient: (config) => new McpServerClient({ ...config, spawnImpl }),
    connectTimeoutMs: 5_000,
    callTimeoutMs: 5_000,
    ...rest,
  });
  t.after(() => instance.disposeAll());
  return instance;
}

test("a global server contributes mcp_-prefixed tools to any session", async (t) => {
  const dir = stubDir();
  const rt = runtime(t);
  rt.setRecords([stubRecord(dir)]);

  const tools = await rt.toolsForProject("/repo");
  assert.deepEqual(
    tools.map((tool) => tool.fullName),
    ["mcp_stub_lookup", "mcp_stub_ping"],
  );
  assert.equal(tools.every((tool) => tool.planSafe === false), true);
  assert.equal(tools[0].description, "Look something up");
  // A tool with no description of its own still gets one the model can read.
  assert.match(tools[1].description, /Stub/);
  assert.equal(rt.statusFor("stub").state, "ready");
  assert.equal(rt.statusFor("stub").toolCount, 2);

  // A session with no project at all still sees a global server.
  assert.equal((await rt.toolsForProject(null)).length, 2);
});

test("refreshing HTTP MCP status detects a server that went offline", async (t) => {
  let online = true;
  let pings = 0;
  let connected = false;
  let finishCall;
  let failCall;
  let markCallStarted;
  const callStarted = new Promise((resolve) => { markCallStarted = resolve; });
  const client = {
    isConnected: () => connected,
    getTools: () => [{ name: "lookup" }],
    connect: async () => { connected = true; return [{ name: "lookup" }]; },
    callTool: () => new Promise((resolve, reject) => {
      finishCall = resolve;
      failCall = reject;
      markCallStarted();
    }),
    ping: async () => {
      pings += 1;
      if (!online) throw new Error("server offline");
    },
    close: () => {
      connected = false;
      failCall?.(new Error("tool call interrupted by close"));
    },
  };
  const rt = new UserMcpRuntime({ createClient: () => client });
  t.after(() => rt.disposeAll());
  rt.setRecords([stubRecord("/unused", { transport: "http", command: undefined, args: undefined, url: "http://127.0.0.1:9999/mcp" })]);

  await rt.toolsForProject("/repo");
  assert.equal(rt.statusFor("stub").state, "ready");
  assert.equal((await rt.refreshStatuses())[0].state, "ready");
  const pendingCall = rt.callTool("mcp_stub_lookup", {}, "/repo");
  await callStarted;
  online = false;
  const statuses = await rt.refreshStatuses();
  assert.equal(statuses[0].state, "failed");
  assert.equal(rt.statusFor("stub").state, "failed");
  assert.equal(connected, true, "a settings probe must not close an in-flight call");
  finishCall({ content: [{ type: "text", text: "completed" }] });
  assert.deepEqual(await pendingCall, { content: [{ type: "text", text: "completed" }] });
  assert.equal(pings, 2);
});

test("an OAuth wait cannot reuse an obsolete server configuration", async (t) => {
  const oldToken = Promise.withResolvers();
  const newToken = Promise.withResolvers();
  const tokens = [oldToken, newToken];
  const connectedUrls = [];
  const calledUrls = [];
  const rt = runtime(t, {
    oauth: {
      getValidAccessToken: () => tokens.shift()?.promise ?? Promise.resolve(null),
      hasOAuth: async () => false,
    },
    createClient: ({ server }) => {
      let connected = false;
      return {
        connect: async () => { connected = true; connectedUrls.push(server.url); return [{ name: "lookup" }]; },
        getTools: () => connected ? [{ name: "lookup" }] : [],
        isConnected: () => connected,
        close: () => { connected = false; },
        callTool: async () => { calledUrls.push(server.url); return server.url; },
      };
    },
  });
  const old = stubRecord("/unused", {
    transport: "http", command: undefined, args: undefined,
    url: "http://old.invalid/mcp", planSafeTools: [],
  });
  rt.setRecords([old]);
  const discovery = rt.toolsForProject("/repo");
  const saved = { ...old, url: "http://new.invalid/mcp", planSafeTools: ["lookup"] };
  rt.setRecords([saved]);
  const testing = rt.test(saved.id);
  oldToken.resolve(null);
  const obsolete = await discovery;
  newToken.resolve(null);
  assert.equal((await testing).state, "ready");
  const tools = await rt.toolsForProject("/repo");
  assert.equal(tools[0].planSafe, true);
  assert.equal(await rt.callTool("mcp_stub_lookup", {}, "/repo"), saved.url);
  assert.deepEqual(obsolete, []);
  assert.deepEqual(connectedUrls, [saved.url]);
  assert.deepEqual(calledUrls, [saved.url]);
});

test("authorization completion cannot restore a superseded server", async (t) => {
  const connectedUrls = [];
  const rt = runtime(t, {
    createClient: ({ server }) => {
      let connected = false;
      return {
        connect: async () => { connected = true; connectedUrls.push(server.url); return [{ name: "lookup" }]; },
        getTools: () => connected ? [{ name: "lookup" }] : [],
        isConnected: () => connected,
        close: () => { connected = false; },
        callTool: async () => server.url,
      };
    },
  });
  const captured = stubRecord("/unused", {
    transport: "http", command: undefined, args: undefined,
    url: "http://old.invalid/mcp", enabled: true,
  });
  for (const current of [undefined, { ...captured, url: "http://new.invalid/mcp", enabled: false }]) {
    const status = await reconnectAuthorizedMcp(rt, captured, current);
    assert.equal(status.state, "failed");
  }
  assert.deepEqual(connectedUrls, []);
  assert.deepEqual(rt.listRecords(), []);

  const status = await reconnectAuthorizedMcp(rt, captured, captured);
  assert.equal(status.state, "ready");
  assert.deepEqual(connectedUrls, [captured.url]);
  assert.deepEqual(rt.listRecords(), []);
  rt.setRecords([captured]);
  assert.equal((await reconnectAuthorizedMcp(rt, captured, captured)).state, "ready");
  assert.deepEqual(rt.listRecords().map((item) => item.url), [captured.url]);

});

test("stopping one session cancels only its active MCP call", async (t) => {
  const started = new Map();
  const finish = new Map();
  const client = {
    isConnected: () => true,
    getTools: () => [{ name: "lookup" }],
    close: () => {},
    connect: async () => [{ name: "lookup" }],
    callTool: async (_name, args, signal) => new Promise((resolve, reject) => {
      finish.set(args.id, resolve);
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      started.get(args.id)();
    }),
  };
  const rt = new UserMcpRuntime({ createClient: () => client });
  t.after(() => rt.disposeAll());
  rt.setRecords([stubRecord("/unused")]);
  await rt.toolsForProject("/repo");

  const firstStarted = new Promise((resolve) => started.set("first", resolve));
  const first = rt.callTool("mcp_stub_lookup", { id: "first" }, "/repo", "session-a");
  await firstStarted;
  const secondStarted = new Promise((resolve) => started.set("second", resolve));
  const second = rt.callTool("mcp_stub_lookup", { id: "second" }, "/repo", "session-b");
  await secondStarted;

  rt.cancelSessionCalls("session-a");
  await assert.rejects(first, /aborted/);
  finish.get("second")("finished");
  assert.equal(await second, "finished");
});

test("a project-scoped server is invisible outside its projects", async (t) => {
  const dir = stubDir();
  const rt = runtime(t);
  rt.setRecords([stubRecord(dir, { scope: { mode: "projects", projects: ["/repo"] } })]);

  assert.deepEqual(await rt.toolsForProject("/elsewhere"), []);
  assert.deepEqual(await rt.toolsForProject(null), []);
  // Subdirectories of a scoped project count as inside it.
  assert.equal((await rt.toolsForProject("/repo/apps/web")).length, 2);
});

test("a disabled server contributes nothing and is never connected", async (t) => {
  const dir = stubDir();
  const rt = runtime(t);
  rt.setRecords([stubRecord(dir, { enabled: false })]);

  assert.deepEqual(await rt.toolsForProject("/repo"), []);
  assert.equal(rt.statusFor("stub").state, "idle");
});

// Scope has to hold at dispatch too: a session assembled before the user
// narrowed the scope still remembers the tool name.
test("a call is refused once the server no longer applies to the session", async (t) => {
  const dir = stubDir();
  const rt = runtime(t);
  rt.setRecords([stubRecord(dir)]);
  await rt.toolsForProject("/repo");

  const before = await rt.callTool("mcp_stub_lookup", {}, "/repo");
  assert.match(JSON.stringify(before), /lookup/);

  rt.setRecords([stubRecord(dir, { scope: { mode: "projects", projects: ["/other"] } })]);
  await rt.toolsForProject("/other");
  await assert.rejects(rt.callTool("mcp_stub_lookup", {}, "/repo"), (error) => {
    assert.equal(error.errorCode, "TOOL_NOT_FOUND");
    assert.match(error.message, /not active for this session/);
    return true;
  });
});

test("a name the server never advertised is refused, not forwarded", async (t) => {
  const dir = stubDir();
  const rt = runtime(t);
  rt.setRecords([stubRecord(dir)]);
  await rt.toolsForProject("/repo");

  await assert.rejects(rt.callTool("mcp_stub_delete_everything", {}, "/repo"), (error) => {
    assert.equal(error.errorCode, "TOOL_NOT_FOUND");
    return true;
  });
});

test("editing what a server runs drops the live connection", async (t) => {
  const dir = stubDir();
  const rt = runtime(t);
  rt.setRecords([stubRecord(dir, { env: { STUB_TAG: "first" } })]);
  await rt.toolsForProject("/repo");
  assert.match(JSON.stringify(await rt.callTool("mcp_stub_lookup", {}, "/repo")), /first:lookup/);

  rt.setRecords([stubRecord(dir, { env: { STUB_TAG: "second" } })]);
  // Routing survives the edit, but dispatch must handshake the new config.
  assert.equal(rt.hasTool("mcp_stub_lookup"), true);
  assert.equal(rt.statusFor("stub").state, "idle");

  assert.match(JSON.stringify(await rt.callTool("mcp_stub_lookup", {}, "/repo")), /second:lookup/);
});

test("a terminated stdio process recovers on the next tool call", async (t) => {
  const dir = stubDir();
  const pidFile = join(dir, "pid");
  let client;
  const rt = runtime(t, {
    createClient: (config) => { client = new McpServerClient(config); return client; },
  });
  rt.setRecords([stubRecord(dir, { env: { STUB_PID_FILE: pidFile } })]);
  await rt.toolsForProject("/repo");
  process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM");
  for (let attempt = 0; client.isConnected() && attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(client.isConnected(), false);
  assert.deepEqual(client.getTools(), []);
  assert.match(JSON.stringify(await rt.callTool("mcp_stub_lookup", {}, "/repo")), /lookup/);
  assert.equal(rt.statusFor("stub").state, "ready");
});

test("changing only scope or label keeps the connection", async (t) => {
  const dir = stubDir();
  const rt = runtime(t);
  rt.setRecords([stubRecord(dir)]);
  await rt.toolsForProject("/repo");

  rt.setRecords([
    stubRecord(dir, { label: "Renamed", scope: { mode: "projects", projects: ["/repo"] } }),
  ]);
  assert.equal(rt.statusFor("stub").state, "ready");
  assert.equal(rt.hasTool("mcp_stub_lookup"), true);
});

/** A transport disconnect clears the client's tools, just like onClose. */
function reconnectingRuntime(t) {
  let connected = false;
  let tools = [];
  const state = { handshakes: 0, calls: [], advertised: [{ name: "lookup" }], fail: false, gate: null };
  const client = {
    isConnected: () => connected,
    getTools: () => tools,
    close: () => { connected = false; tools = []; },
    connect: async () => {
      state.handshakes += 1;
      await state.gate;
      if (state.fail) throw new Error("offline");
      connected = true;
      tools = state.advertised;
      return tools;
    },
    callTool: async (name) => { state.calls.push(name); return name; },
  };
  const rt = new UserMcpRuntime({ createClient: () => client });
  t.after(() => rt.disposeAll());
  rt.setRecords([stubRecord("/unused")]);
  return { rt, client, state };
}

test("an advertised tool reconnects after transport loss without another search", async (t) => {
  const { rt, client, state } = reconnectingRuntime(t);
  await rt.toolsForProject("/repo");
  client.close();
  assert.equal(await rt.callTool("mcp_stub_lookup", {}, "/repo"), "lookup");
  assert.equal(state.handshakes, 2);
  assert.deepEqual(state.calls, ["lookup"]);
});

test("reconnection revalidates the advertised tool list before dispatch", async (t) => {
  for (const advertised of [[{ name: "replacement" }], [{ name: "search-docs" }, { name: "search_docs" }], [{ name: "search_docs" }]]) {
    const { rt, client, state } = reconnectingRuntime(t);
    rt.setRecords([stubRecord("/unused", { planSafeTools: ["search-docs"] })]);
    state.advertised = [{ name: "search-docs" }];
    const [admitted] = await rt.toolsForProject("/repo");
    assert.equal(admitted.planSafe, true);
    client.close();
    state.advertised = advertised;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(rt.callTool(admitted.fullName, {}, "/repo", "old-session", admitted), { errorCode: "TOOL_NOT_FOUND" });
    }
    const renamed = advertised.length === 1 && advertised[0].name === "search_docs";
    assert.equal(rt.hasTool(admitted.fullName), renamed);
    assert.equal(state.handshakes, 2);
    assert.deepEqual(state.calls, []);
    if (renamed) {
      const [fresh] = await rt.toolsForProject("/repo");
      assert.equal(fresh.planSafe, false, "The renamed raw tool is not in the saved Plan/Goal list");
      assert.equal(await rt.callTool(fresh.fullName, {}, "/repo", "new-agent-session", fresh), "search_docs");
      assert.deepEqual(state.calls, ["search_docs"]);
    }
  }
});

test("a failed reconnect reports unavailability without repeated handshakes", async (t) => {
  const { rt, client, state } = reconnectingRuntime(t);
  await rt.toolsForProject("/repo");
  client.close();
  state.fail = true;
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(rt.callTool("mcp_stub_lookup", {}, "/repo"), { errorCode: "UNAVAILABLE" });
  }
  assert.equal(state.handshakes, 2);
  assert.deepEqual(state.calls, []);
});

test("scope and enablement are checked before reconnecting a remembered tool", async (t) => {
  for (const change of [{ enabled: false }, { scope: { mode: "projects", projects: ["/other"] } }]) {
    const { rt, client, state } = reconnectingRuntime(t);
    await rt.toolsForProject("/repo");
    client.close();
    rt.setRecords([stubRecord("/unused", change)]);
    await assert.rejects(rt.callTool("mcp_stub_lookup", {}, "/repo"), (error) => {
      assert.equal(error.errorCode, "TOOL_NOT_FOUND");
      assert.match(error.message, /not active for this session/);
      return true;
    });
    assert.equal(state.handshakes, 1);
    assert.deepEqual(state.calls, []);
  }
});

test("concurrent calls share one recovery handshake", async (t) => {
  const { rt, client, state } = reconnectingRuntime(t);
  await rt.toolsForProject("/repo");
  client.close();
  let release;
  state.gate = new Promise((resolve) => { release = resolve; });
  const first = rt.callTool("mcp_stub_lookup", {}, "/repo");
  const second = rt.callTool("mcp_stub_lookup", {}, "/repo");
  assert.equal(state.handshakes, 2);
  release();
  assert.deepEqual(await Promise.all([first, second]), ["lookup", "lookup"]);
});

test("scope changes during recovery prevent dispatch", async (t) => {
  const { rt, client, state } = reconnectingRuntime(t);
  await rt.toolsForProject("/repo");
  client.close();
  let release;
  state.gate = new Promise((resolve) => { release = resolve; });
  const pending = rt.callTool("mcp_stub_lookup", {}, "/repo");
  rt.setRecords([stubRecord("/unused", { scope: { mode: "projects", projects: ["/other"] } })]);
  release();
  await assert.rejects(pending, { errorCode: "TOOL_NOT_FOUND" });
  assert.deepEqual(state.calls, []);
});

test("removing a server during recovery cannot restore its tools", async (t) => {
  const { rt, client, state } = reconnectingRuntime(t);
  await rt.toolsForProject("/repo");
  client.close();
  let release;
  state.gate = new Promise((resolve) => { release = resolve; });
  const pending = rt.callTool("mcp_stub_lookup", {}, "/repo");
  rt.setRecords([]);
  release();
  await assert.rejects(pending, { errorCode: "TOOL_NOT_FOUND" });
  assert.equal(rt.hasTool("mcp_stub_lookup"), false);
  assert.equal(client.isConnected(), false);
  assert.deepEqual(state.calls, []);
});

test("unknown names never cause a handshake and failed calls are not replayed", async (t) => {
  const { rt, client, state } = reconnectingRuntime(t);
  await assert.rejects(rt.callTool("mcp_stub_lookup", {}, "/repo"), { errorCode: "TOOL_NOT_FOUND" });
  assert.equal(state.handshakes, 0);
  await rt.toolsForProject("/repo");
  client.callTool = async (name) => {
    state.calls.push(name);
    client.close();
    throw Object.assign(new Error("response lost"), { errorCode: "UNAVAILABLE" });
  };
  await assert.rejects(rt.callTool("mcp_stub_lookup", {}, "/repo"), { errorCode: "UNAVAILABLE" });
  assert.deepEqual(state.calls, ["lookup"]);
  assert.equal(state.handshakes, 1);
});

test("a broken server fails as status and is not retried every session", async (t) => {
  const dir = stubDir();
  const attempts = [];
  const rt = runtime(t, {
    spawnImpl: (command) => {
      attempts.push(command);
      throw new Error("spawn refused");
    },
  });
  rt.setRecords([stubRecord(dir)]);

  assert.deepEqual(await rt.toolsForProject("/repo"), []);
  const status = rt.statusFor("stub");
  assert.equal(status.state, "failed");
  assert.ok(status.message);

  assert.deepEqual(await rt.toolsForProject("/repo"), []);
  assert.equal(attempts.length, 1, "a failed server was reconnected during session assembly");
});

test("testing a server retries it and reports the tools it found", async (t) => {
  const dir = stubDir();
  const rt = runtime(t);
  // Point at a script that does not exist, so the first handshake fails.
  rt.setRecords([stubRecord(dir, { args: [join(dir, "missing.mjs")] })]);
  const failed = await rt.test("stub");
  assert.equal(failed.state, "failed");

  rt.setRecords([stubRecord(dir)]);
  const ready = await rt.test("stub");
  assert.equal(ready.state, "ready");
  assert.deepEqual(ready.toolNames, ["lookup", "ping"]);
});

test("testing a server that is not saved reports it instead of throwing", async (t) => {
  const rt = runtime(t);
  rt.setRecords([]);
  const status = await rt.test("ghost");
  assert.equal(status.state, "failed");
  assert.match(status.message, /not found/);
});

test("statuses are listed for every saved server, connected or not", async (t) => {
  const dir = stubDir();
  const rt = runtime(t);
  rt.setRecords([stubRecord(dir), stubRecord(dir, { id: "second", enabled: false })]);

  await rt.toolsForProject("/repo");
  const statuses = rt.listStatuses();
  assert.deepEqual(
    statuses.map((entry) => [entry.serverId, entry.state]),
    [
      ["stub", "ready"],
      ["second", "idle"],
    ],
  );
});

test("disposing the runtime kills the server processes", async (t) => {
  const dir = stubDir();
  const pidFile = join(dir, "pid");
  const rt = new UserMcpRuntime({
    createClient: (config) => new McpServerClient(config),
    connectTimeoutMs: 5_000,
    callTimeoutMs: 5_000,
  });

  rt.setRecords([stubRecord(dir, { env: { STUB_PID_FILE: pidFile } })]);
  await rt.toolsForProject("/repo");

  const pid = Number(readFileSync(pidFile, "utf8"));
  rt.disposeAll();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("user mcp child survived disposeAll()");
});

test("configurationChanged separates what a server is from who may use it", () => {
  const base = {
    id: "s",
    label: "S",
    transport: "stdio",
    command: "node",
    args: ["a.mjs"],
    env: { A: "1" },
    enabled: true,
    scope: { mode: "global", projects: [] },
  };

  assert.equal(configurationChanged(base, { ...base }), false);
  assert.equal(configurationChanged(base, { ...base, label: "Other" }), false);
  assert.equal(
    configurationChanged(base, { ...base, scope: { mode: "projects", projects: ["/repo"] } }),
    false,
  );
  assert.equal(configurationChanged(base, { ...base, description: "new" }), false);

  assert.equal(configurationChanged(base, { ...base, command: "deno" }), true);
  assert.equal(configurationChanged(base, { ...base, args: ["b.mjs"] }), true);
  assert.equal(configurationChanged(base, { ...base, env: { A: "2" } }), true);
  assert.equal(configurationChanged(base, { ...base, transport: "http", url: "https://x" }), true);
  assert.equal(configurationChanged(base, { ...base, timeoutSeconds: 30 }), true);
  assert.equal(configurationChanged(base, { ...base, enabled: false }), true);
  // Re-enabling does not invalidate anything: nothing was running.
  assert.equal(configurationChanged({ ...base, enabled: false }, base), false);
});

test("a server whose catalog cannot be listed lands as failed with the reason", async (t) => {
  const dir = stubDir();
  const rt = runtime(t);
  rt.setRecords([stubRecord(dir, { env: { STUB_REPEAT_CURSOR: "1" } })]);

  // The guard trips inside the handshake, so the server contributes nothing
  // rather than a prefix of its catalog.
  assert.deepEqual(await rt.toolsForProject("/repo"), []);
  const status = rt.statusFor("stub");
  assert.equal(status.state, "failed");
  assert.equal(status.toolCount, 0);
  assert.match(status.message, /repeated a tools\/list cursor/);

  // A server that already failed this run is not handshaken again per session.
  assert.deepEqual(await rt.toolsForProject("/repo"), []);
  assert.equal(rt.statusFor("stub").state, "failed");
});

test("hyphenated raw names are marked before full-name conversion and dispatched unchanged", async (t) => {
  const dir = stubDir();
  const rt = runtime(t);
  rt.setRecords([stubRecord(dir, {
    id: "ctx-docs", env: { STUB_TOOL_NAME: "search-docs" }, planSafeTools: ["search-docs"],
  })]);
  const tools = await rt.toolsForProject("/repo");
  const search = tools.find((tool) => tool.toolName === "search-docs");
  assert.equal(search?.planSafe, true);
  assert.equal(search?.fullName, "mcp_ctx_docs_search_docs");
  assert.equal(tools.find((tool) => tool.toolName === "ping")?.planSafe, false);
  const result = await rt.callTool(search.fullName, {}, "/repo");
  assert.equal(result.content[0].text, "untagged:search-docs");
});

test("ambiguous full names cannot mix admission with another raw tool or server", async (t) => {
  const release = Promise.withResolvers();
  const secondReady = Promise.withResolvers();
  const completed = [];
  const calls = [];
  const rt = runtime(t, {
    createClient: ({ server }) => {
      let connected = false;
      const tools = server.id === "ctx-docs"
        ? [{ name: "lookup" }, { name: "search-docs" }, { name: "search_docs" }]
        : [{ name: "lookup" }];
      return {
        connect: async () => {
          if (server.id === "ctx-docs") await release.promise;
          connected = true;
          completed.push(server.id);
          if (server.id === "ctx_docs") secondReady.resolve();
          return tools;
        },
        getTools: () => tools,
        isConnected: () => connected,
        close: () => { connected = false; },
        callTool: async (name) => { calls.push([server.id, name]); return name; },
      };
    },
  });
  rt.setRecords([
    stubRecord("/unused", { id: "ctx-docs", planSafeTools: ["lookup", "search-docs"] }),
    stubRecord("/unused", { id: "ctx_docs", planSafeTools: [] }),
  ]);
  const pending = rt.toolsForProject("/repo");
  await secondReady.promise;
  release.resolve();
  const tools = await pending;
  assert.deepEqual(completed, ["ctx_docs", "ctx-docs"]);
  for (const name of ["mcp_ctx_docs_lookup", "mcp_ctx_docs_search_docs"]) {
    await assert.rejects(rt.callTool(name, {}, "/repo"), { errorCode: "TOOL_NOT_FOUND" });
    assert.equal(rt.hasTool(name), false);
  }
  assert.deepEqual(tools, []);
  assert.deepEqual(calls, []);
});

test("saving planSafeTools through IPC updates the next tool list without reconnecting", async (t) => {
  const dir = stubDir();
  const pidFile = join(dir, "pid");
  const rt = runtime(t);
  let record = stubRecord(dir, { level: "global", env: { STUB_PID_FILE: pidFile }, planSafeTools: ["lookup"] });
  let shadow = null;
  const handlers = new Map();
  registerMcpIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({
      call: async (method, payload) => {
        if (method === "mcp.list") return { servers: [record] };
        assert.equal(method, "mcp.upsert");
        record = { ...record, ...payload.server };
        return { server: record };
      },
    }),
    userMcp: rt,
    currentWorkspacePath: () => "/repo",
    refreshUserMcp: async () => { const active = [shadow ?? record]; rt.setRecords(active); return active; },
    describeError: String,
    sendToRenderer: () => {},
    searchMcpMarket: async () => ({ entries: [] }),
  });
  const save = handlers.get(IPC.invoke.mcpUpsert);
  rt.setRecords([record]);
  const before = await rt.toolsForProject("/repo");
  const pid = readFileSync(pidFile, "utf8");
  assert.equal(before.find((tool) => tool.toolName === "lookup")?.planSafe, true);
  await save({ id: record.id, planSafeTools: ["ping"] });
  const after = await rt.toolsForProject("/repo");
  assert.equal(after.find((tool) => tool.toolName === "lookup")?.planSafe, false);
  assert.equal(after.find((tool) => tool.toolName === "ping")?.planSafe, true);
  assert.equal(readFileSync(pidFile, "utf8"), pid);
  assert.equal((await rt.callTool("mcp_stub_ping", {}, "/repo")).content[0].text, "untagged:ping");
  await save({ id: record.id, planSafeTools: [] });
  assert.equal((await rt.toolsForProject("/repo")).every((tool) => !tool.planSafe), true);
  assert.equal(readFileSync(pidFile, "utf8"), pid);

  await save({ id: record.id, env: { ...record.env, STUB_TAG: "edited" } });
  assert.equal((await rt.callTool("mcp_stub_lookup", {}, "/repo")).content[0].text, "edited:lookup");
  const editedPid = readFileSync(pidFile, "utf8");
  assert.notEqual(editedPid, pid);
  const tested = await handlers.get(IPC.invoke.mcpTest)({ id: record.id });
  assert.equal(tested.status.state, "ready");
  assert.notEqual(readFileSync(pidFile, "utf8"), editedPid);

  const projectPidFile = join(dir, "project-pid");
  shadow = stubRecord(dir, {
    level: "project", projectPath: "/repo", planSafeTools: ["lookup"],
    env: { STUB_PID_FILE: projectPidFile, STUB_TAG: "project" },
  });
  rt.setRecords([shadow]);
  await rt.toolsForProject("/repo");
  const projectPid = readFileSync(projectPidFile, "utf8");
  await save({ id: record.id, level: "global", planSafeTools: ["ping"] });
  const projectTools = await rt.toolsForProject("/repo");
  assert.equal(readFileSync(projectPidFile, "utf8"), projectPid);
  assert.equal(projectTools.find((tool) => tool.toolName === "lookup")?.planSafe, true);
  assert.equal((await rt.callTool("mcp_stub_ping", {}, "/repo")).content[0].text, "project:ping");
});

test("custom timeoutSeconds overrides default connect and call timeouts on client creation", () => {
  let createdConfig = null;
  const rt = new UserMcpRuntime({
    createClient: (config) => {
      createdConfig = config;
      return {
        connect: async () => [],
        callTool: async () => ({}),
        getTools: () => [],
        isConnected: () => false,
        close: () => {},
        ping: async () => {},
      };
    },
    connectTimeoutMs: 10_000,
    callTimeoutMs: 100_000,
    discoveryTimeoutMs: 30_000,
  });

  rt.setRecords([
    {
      id: "slow-server",
      label: "Slow Server",
      transport: "stdio",
      command: "node",
      args: ["slow.mjs"],
      enabled: true,
      timeoutSeconds: 45,
      createdAt: "",
      updatedAt: "",
    },
  ]);

  void rt.connect(rt.listRecords()[0]);
  assert.ok(createdConfig);
  assert.equal(createdConfig.connectTimeoutMs, 45_000);
  assert.equal(createdConfig.callTimeoutMs, 100_000);
  assert.equal(createdConfig.discoveryTimeoutMs, 45_000);
});
