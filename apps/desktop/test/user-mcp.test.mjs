import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { UserMcpRuntime, configurationChanged } from "../electron/main/user-mcp.ts";
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
        tools: [
          { name: "lookup", description: "Look something up" },
          { name: "ping" },
          ...(process.env.STUB_REPORT_CWD ? [{ name: "cwd" }] : []),
          ...(process.cwd() === process.env.STUB_TOOL_ONLY_IN_CWD ? [{ name: "project_only" }] : []),
        ],
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
      result: {
        content: [{
          type: "text",
          text: msg.params.name === "cwd"
            ? process.cwd() + "|" + process.pid
            : tag + ":" + msg.params.name,
        }],
      },
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

function projectDir(name = "project") {
  return realpathSync(mkdtempSync(join(tmpdir(), `pi-user-mcp-${name}-`)));
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
  const projectPath = projectDir();
  const rt = runtime(t);
  rt.setRecords([stubRecord(dir)]);

  const tools = await rt.toolsForProject(projectPath);
  assert.deepEqual(
    tools.map((tool) => tool.fullName),
    ["mcp_stub_lookup", "mcp_stub_ping"],
  );
  assert.equal(tools[0].description, "Look something up");
  // A tool with no description of its own still gets one the model can read.
  assert.match(tools[1].description, /Stub/);
  assert.equal(rt.statusFor("stub").state, "ready");
  assert.equal(rt.statusFor("stub").toolCount, 2);

  // A session with no project at all still sees a global server.
  assert.equal((await rt.toolsForProject(null)).length, 2);
});

test("a stdio server runs from and is reused only within its session workspace", async (t) => {
  const serverDir = stubDir();
  const firstProject = projectDir("project-a");
  const secondProject = projectDir("project-b");
  const rt = runtime(t);
  rt.setRecords([stubRecord(serverDir, {
    env: { STUB_REPORT_CWD: "1", STUB_TOOL_ONLY_IN_CWD: firstProject },
  })]);

  const firstTools = await rt.toolsForProject(firstProject);
  const secondTools = await rt.toolsForProject(secondProject);
  const projectlessTools = await rt.toolsForProject(null);
  assert.ok(firstTools.some((tool) => tool.fullName === "mcp_stub_cwd"));
  assert.ok(secondTools.some((tool) => tool.fullName === "mcp_stub_cwd"));
  assert.ok(firstTools.some((tool) => tool.fullName === "mcp_stub_project_only"));
  assert.ok(!secondTools.some((tool) => tool.fullName === "mcp_stub_project_only"));
  assert.ok(projectlessTools.some((tool) => tool.fullName === "mcp_stub_cwd"));

  const firstResult = await rt.callTool("mcp_stub_cwd", {}, firstProject);
  const firstAgain = await rt.callTool("mcp_stub_cwd", {}, firstProject);
  const secondResult = await rt.callTool("mcp_stub_cwd", {}, secondProject);
  const projectlessResult = await rt.callTool("mcp_stub_cwd", {}, null);
  const firstValue = firstResult.content[0].text;
  const firstAgainValue = firstAgain.content[0].text;
  const secondValue = secondResult.content[0].text;
  const projectlessValue = projectlessResult.content[0].text;

  assert.equal(firstValue.split("|")[0], firstProject);
  assert.equal(firstAgainValue, firstValue, "the same workspace should reuse its process");
  assert.equal(secondValue.split("|")[0], secondProject);
  assert.notEqual(secondValue.split("|")[1], firstValue.split("|")[1]);
  assert.equal(projectlessValue.split("|")[0], realpathSync(homedir()));
  await assert.rejects(
    rt.callTool("mcp_stub_project_only", {}, secondProject),
    { errorCode: "TOOL_NOT_FOUND" },
    "a tool advertised in one workspace must not be dispatched through another",
  );
});

test("the stdio connection cache stays bounded and evicted workspaces reconnect", async (t) => {
  let active = 0;
  let peakActive = 0;
  let handshakes = 0;
  const rt = new UserMcpRuntime({
    createClient: () => {
      let connected = false;
      const tools = [{ name: "lookup" }];
      return {
        connect: async () => {
          handshakes += 1;
          connected = true;
          active += 1;
          peakActive = Math.max(peakActive, active);
          return tools;
        },
        getTools: () => connected ? tools : [],
        isConnected: () => connected,
        callTool: async () => "called",
        ping: async () => {},
        close: () => {
          if (!connected) return;
          connected = false;
          active -= 1;
        },
      };
    },
  });
  t.after(() => rt.disposeAll());
  rt.setRecords([stubRecord("/unused")]);

  for (let index = 0; index < 65; index += 1) {
    await rt.toolsForProject(`/workspace/${index}`);
  }
  assert.equal(active, 64);
  assert.equal(peakActive, 64);

  assert.equal(await rt.callTool("mcp_stub_lookup", {}, "/workspace/0"), "called");
  assert.equal(active, 64);
  assert.equal(handshakes, 66, "the evicted workspace should reconnect on demand");

  rt.disposeAll();
  assert.equal(active, 0);
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
  const projectPath = projectDir();
  const nestedProject = join(projectPath, "apps", "web");
  mkdirSync(nestedProject, { recursive: true });
  const rt = runtime(t);
  rt.setRecords([stubRecord(dir, { scope: { mode: "projects", projects: [projectPath] } })]);

  assert.deepEqual(await rt.toolsForProject("/elsewhere"), []);
  assert.deepEqual(await rt.toolsForProject(null), []);
  // Subdirectories of a scoped project count as inside it.
  assert.equal((await rt.toolsForProject(nestedProject)).length, 2);
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
  const projectPath = projectDir();
  const otherProject = projectDir("other");
  const rt = runtime(t);
  rt.setRecords([stubRecord(dir)]);
  await rt.toolsForProject(projectPath);

  const before = await rt.callTool("mcp_stub_lookup", {}, projectPath);
  assert.match(JSON.stringify(before), /lookup/);

  rt.setRecords([stubRecord(dir, { scope: { mode: "projects", projects: [otherProject] } })]);
  await rt.toolsForProject(otherProject);
  await assert.rejects(rt.callTool("mcp_stub_lookup", {}, projectPath), (error) => {
    assert.equal(error.errorCode, "TOOL_NOT_FOUND");
    assert.match(error.message, /not active for this session/);
    return true;
  });
});

test("a name the server never advertised is refused, not forwarded", async (t) => {
  const dir = stubDir();
  const projectPath = projectDir();
  const rt = runtime(t);
  rt.setRecords([stubRecord(dir)]);
  await rt.toolsForProject(projectPath);

  await assert.rejects(rt.callTool("mcp_stub_delete_everything", {}, projectPath), (error) => {
    assert.equal(error.errorCode, "TOOL_NOT_FOUND");
    return true;
  });
});

test("editing what a server runs drops the live connection", async (t) => {
  const dir = stubDir();
  const projectPath = projectDir();
  const rt = runtime(t);
  rt.setRecords([stubRecord(dir, { env: { STUB_TAG: "first" } })]);
  await rt.toolsForProject(projectPath);
  assert.match(JSON.stringify(await rt.callTool("mcp_stub_lookup", {}, projectPath)), /first:lookup/);

  rt.setRecords([stubRecord(dir, { env: { STUB_TAG: "second" } })]);
  // Routing survives the edit, but dispatch must handshake the new config.
  assert.equal(rt.hasTool("mcp_stub_lookup"), true);
  assert.equal(rt.statusFor("stub").state, "idle");

  assert.match(JSON.stringify(await rt.callTool("mcp_stub_lookup", {}, projectPath)), /second:lookup/);
});

test("a terminated stdio process recovers on the next tool call", async (t) => {
  const dir = stubDir();
  const projectPath = projectDir();
  const pidFile = join(dir, "pid");
  let client;
  const rt = runtime(t, {
    createClient: (config) => { client = new McpServerClient(config); return client; },
  });
  rt.setRecords([stubRecord(dir, { env: { STUB_PID_FILE: pidFile } })]);
  await rt.toolsForProject(projectPath);
  process.kill(Number(readFileSync(pidFile, "utf8")), "SIGTERM");
  for (let attempt = 0; client.isConnected() && attempt < 100; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(client.isConnected(), false);
  assert.deepEqual(client.getTools(), []);
  assert.match(JSON.stringify(await rt.callTool("mcp_stub_lookup", {}, projectPath)), /lookup/);
  assert.equal(rt.statusFor("stub").state, "ready");
});

test("changing only scope or label keeps the connection", async (t) => {
  const dir = stubDir();
  const projectPath = projectDir();
  const rt = runtime(t);
  rt.setRecords([stubRecord(dir)]);
  await rt.toolsForProject(projectPath);

  rt.setRecords([
    stubRecord(dir, { label: "Renamed", scope: { mode: "projects", projects: [projectPath] } }),
  ]);
  assert.equal(rt.statusFor("stub").state, "ready");
  assert.equal(rt.hasTool("mcp_stub_lookup"), true);
});

test("refreshing one project's records keeps another project's scoped server connected", async (t) => {
  const dir = stubDir();
  const projectA = projectDir("project-a");
  const projectB = projectDir("project-b");
  const rt = runtime(t);
  rt.setRecords(
    [stubRecord(dir, { scope: { mode: "projects", projects: [projectA] } })],
    projectA,
  );
  const tools = await rt.toolsForProject(projectA);
  assert.deepEqual(
    tools.map((tool) => tool.fullName),
    ["mcp_stub_lookup", "mcp_stub_ping"],
  );
  assert.equal(rt.statusFor("stub").state, "ready");

  // Project B has no active servers, and its refresh (refreshUserMcp(projectB))
  // must not evict project A's scoped server or kill its stdio process.
  rt.setRecords([], projectB);
  assert.equal(rt.statusFor("stub").state, "ready");
  assert.match(JSON.stringify(await rt.callTool("mcp_stub_lookup", {}, projectA)), /lookup/);

  // The retained record stays invisible to project B's sessions.
  assert.deepEqual(await rt.toolsForProject(projectB), []);
  await assert.rejects(rt.callTool("mcp_stub_lookup", {}, projectB), (error) => {
    assert.equal(error.errorCode, "TOOL_NOT_FOUND");
    assert.match(error.message, /not active for this session/);
    return true;
  });
});

test("a scoped server removed from its own project's refresh loses its connection", async (t) => {
  const dir = stubDir();
  const projectA = projectDir("project-a");
  const rt = runtime(t);
  rt.setRecords(
    [stubRecord(dir, { scope: { mode: "projects", projects: [projectA] } })],
    projectA,
  );
  await rt.toolsForProject(projectA);
  assert.equal(rt.statusFor("stub").state, "ready");

  rt.setRecords([], projectA);
  assert.equal(rt.statusFor("stub").state, "idle");
  await assert.rejects(rt.callTool("mcp_stub_lookup", {}, projectA), { errorCode: "TOOL_NOT_FOUND" });
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
  const { rt, client, state } = reconnectingRuntime(t);
  await rt.toolsForProject("/repo");
  client.close();
  state.advertised = [{ name: "replacement" }];
  await assert.rejects(rt.callTool("mcp_stub_lookup", {}, "/repo"), { errorCode: "TOOL_NOT_FOUND" });
  assert.equal(state.handshakes, 2);
  assert.deepEqual(state.calls, []);
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

test("testing a server clears failed workspace caches without an enable toggle", async (t) => {
  const dir = stubDir();
  const firstProject = projectDir("retry-a");
  const secondProject = projectDir("retry-b");
  const readyFile = join(dir, "ready");
  const original = readFileSync(join(dir, "server.mjs"), "utf8");
  writeFileSync(join(dir, "server.mjs"),
    `import { existsSync } from "node:fs";
if (!existsSync(${JSON.stringify(readyFile)})) process.exit(1);
${original}`);
  const rt = runtime(t);
  rt.setRecords([stubRecord(dir, { env: { STUB_REPORT_CWD: "1" } })]);
  assert.deepEqual(await rt.toolsForProject(firstProject), []);
  assert.deepEqual(await rt.toolsForProject(secondProject), []);
  writeFileSync(readyFile, "ready");

  // The default settings test used to repair only the home-directory cache.
  const status = await rt.test("stub");
  assert.equal(status.state, "ready");
  assert.ok((await rt.toolsForProject(firstProject)).some((tool) => tool.fullName === "mcp_stub_cwd"));
  assert.ok((await rt.toolsForProject(secondProject)).some((tool) => tool.fullName === "mcp_stub_cwd"));
  assert.equal((await rt.callTool("mcp_stub_cwd", {}, firstProject)).content[0].text.split("|")[0], firstProject);
  assert.equal((await rt.callTool("mcp_stub_cwd", {}, secondProject)).content[0].text.split("|")[0], secondProject);
});

test("testing a server handshakes its requested workspace", async (t) => {
  const dir = stubDir();
  const projectPath = projectDir("requested");
  const rt = runtime(t);
  rt.setRecords([stubRecord(dir, { env: { STUB_TOOL_ONLY_IN_CWD: projectPath } })]);

  const status = await rt.test("stub", projectPath);
  assert.equal(status.state, "ready");
  assert.ok(status.toolNames.includes("project_only"), "the test must not discover a home-directory catalog");
  assert.equal(await rt.callTool("mcp_stub_project_only", {}, projectPath).then((value) => value.content[0].text), "untagged:project_only");
});

for (const sameProject of [false, true]) {
test(`testing a server does not interrupt a tool call in ${sameProject ? "the same" : "another"} workspace`, async (t) => {
  const firstProject = projectDir("active");
  const testedProject = sameProject ? firstProject : projectDir("tested");
  let started;
  let finish;
  const callStarted = new Promise((resolve) => { started = resolve; });
  const clients = new Map();
  const rt = new UserMcpRuntime({
    createClient: ({ rootPath }) => {
      let connected = false;
      const tools = [{ name: "lookup" }];
      const client = {
        connect: async () => { connected = true; return tools; },
        getTools: () => connected ? tools : [],
        isConnected: () => connected,
        callTool: async () => new Promise((resolve, reject) => {
          finish = resolve;
          client.failCall = reject;
          started();
        }),
        close: () => { connected = false; client.failCall?.(new Error("active call interrupted")); },
        ping: async () => {},
      };
      clients.set(rootPath, client);
      return client;
    },
  });
  t.after(() => rt.disposeAll());
  rt.setRecords([stubRecord("/unused")]);
  await rt.toolsForProject(firstProject);
  const activeClient = clients.get(firstProject);
  const pending = rt.callTool("mcp_stub_lookup", {}, firstProject);
  await callStarted;

  assert.equal((await rt.test("stub", testedProject)).state, "ready");
  assert.equal(activeClient.isConnected(), true);
  finish("completed");
  assert.equal(await pending, "completed");
  assert.equal(clients.get(firstProject), activeClient);
});

}

test("testing a server reuses its pending workspace handshake", async (t) => {
  const projectPath = projectDir("connecting");
  let release;
  let closeCount = 0;
  let handshakes = 0;
  let connected = false;
  const gate = new Promise((resolve) => { release = resolve; });
  const tools = [{ name: "lookup" }];
  const rt = new UserMcpRuntime({
    createClient: () => ({
      connect: async () => { handshakes += 1; await gate; connected = true; return tools; },
      getTools: () => connected ? tools : [],
      isConnected: () => connected,
      close: () => { closeCount += 1; connected = false; },
      callTool: async () => "called",
      ping: async () => {},
    }),
  });
  t.after(() => rt.disposeAll());
  rt.setRecords([stubRecord("/unused")]);
  const pendingTools = rt.toolsForProject(projectPath);
  const pendingTest = rt.test("stub", projectPath);
  assert.equal(closeCount, 0);
  release();
  assert.equal((await pendingTools)[0].fullName, "mcp_stub_lookup");
  assert.equal((await pendingTest).state, "ready");
  assert.equal(handshakes, 1);
});

for (const pendingHandshake of [false, true]) {
  test(`testing HTTP MCP during token rotation preserves a pending ${pendingHandshake ? "handshake" : "call"}`, async (t) => {
    let token = "first";
    let release;
    let markStarted;
    const gate = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { markStarted = resolve; });
    const clients = [];
    const tools = [{ name: "lookup" }];
    const rt = new UserMcpRuntime({
      oauth: { getValidAccessToken: async () => token, hasOAuth: async () => true },
      createClient: ({ server }) => {
        let connected = false;
        let rejectCall;
        const client = {
          token: server.headers.Authorization,
          closes: 0,
          connect: async () => {
            if (pendingHandshake && clients.length === 1) { markStarted(); await gate; }
            connected = true;
            return tools;
          },
          getTools: () => connected ? tools : [],
          isConnected: () => connected,
          callTool: () => new Promise((resolve, reject) => {
            rejectCall = reject;
            markStarted();
            gate.then(() => resolve("completed"));
          }),
          close: () => { client.closes += 1; connected = false; rejectCall?.(new Error("call interrupted")); },
          ping: async () => {},
        };
        clients.push(client);
        return client;
      },
    });
    t.after(() => rt.disposeAll());
    rt.setRecords([stubRecord("/unused", { transport: "http", command: undefined, args: undefined, url: "http://127.0.0.1:9999/mcp" })]);
    let pending;
    if (pendingHandshake) pending = rt.toolsForProject("/repo");
    else {
      await rt.toolsForProject("/repo");
      pending = rt.callTool("mcp_stub_lookup", {}, "/repo");
    }
    await started;
    token = "second";
    const tested = rt.test("stub", "/repo");
    // Explicitly release the old operation, then verify no replacement killed it.
    release();
    assert.equal((await tested).state, "ready");
    if (pendingHandshake) assert.equal((await pending)[0].fullName, "mcp_stub_lookup");
    else assert.equal(await pending, "completed");
    assert.equal(clients[0].closes, 0);
    await rt.toolsForProject("/repo");
    assert.equal(clients.at(-1).token, "Bearer second");
    assert.equal(clients[0].closes, 1, "rotation is deferred until the original operation is idle");
  });
}

test("testing a server that is not saved reports it instead of throwing", async (t) => {
  const rt = runtime(t);
  rt.setRecords([]);
  const status = await rt.test("ghost");
  assert.equal(status.state, "failed");
  assert.match(status.message, /not found/);
});

test("statuses are listed for every saved server, connected or not", async (t) => {
  const dir = stubDir();
  const projectPath = projectDir();
  const rt = runtime(t);
  rt.setRecords([stubRecord(dir), stubRecord(dir, { id: "second", enabled: false })]);

  await rt.toolsForProject(projectPath);
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
  const projectPath = projectDir();
  const pidFile = join(dir, "pid");
  const rt = new UserMcpRuntime({
    createClient: (config) => new McpServerClient(config),
    connectTimeoutMs: 5_000,
    callTimeoutMs: 5_000,
  });

  rt.setRecords([stubRecord(dir, { env: { STUB_PID_FILE: pidFile } })]);
  await rt.toolsForProject(projectPath);

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
  const projectPath = projectDir();
  const rt = runtime(t);
  rt.setRecords([stubRecord(dir, { env: { STUB_REPEAT_CURSOR: "1" } })]);

  // The guard trips inside the handshake, so the server contributes nothing
  // rather than a prefix of its catalog.
  assert.deepEqual(await rt.toolsForProject(projectPath), []);
  const status = rt.statusFor("stub");
  assert.equal(status.state, "failed");
  assert.equal(status.toolCount, 0);
  assert.match(status.message, /repeated a tools\/list cursor/);

  // A server that already failed this run is not handshaken again per session.
  assert.deepEqual(await rt.toolsForProject(projectPath), []);
  assert.equal(rt.statusFor("stub").state, "failed");
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
