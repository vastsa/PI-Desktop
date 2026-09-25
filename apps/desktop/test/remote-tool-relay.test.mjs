import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createRemoteToolRelay } = await import(
  "../electron/main/remote/remote-tool-relay.ts"
);

const TOOL = {
  fullName: "mcp_global_lookup",
  description: "Search the configured service",
  schema: {
    type: "object",
    properties: { query: { type: "string", minLength: 1 } },
    required: ["query"],
    additionalProperties: false,
  },
};

function setup({ pairedDevice = true, roles = ["owner"], toolRelay = true, tools = [TOOL], executeTool, scheduleTimeout } = {}) {
  const calls = [];
  const canceled = [];
  const invocations = [];
  let currentTools = tools;
  const relay = createRemoteToolRelay({
    hostKey: "hostA",
    pairedDevice,
    client: {
      initialized: () => ({ principal: { roles } }),
      hostCapabilities: () => ({ toolRelay }),
      request: async (method, params) => {
        calls.push({ method, params });
        return { advertised: params.tools.length };
      },
    },
    userMcp: {
      toolsForRemoteSession: async () => currentTools,
      callTool: (toolName, args, projectPath, executionKey) => {
        invocations.push({ toolName, args, projectPath, executionKey });
        const run = executeTool ?? (async (name, input, _projectPath, key) => ({
          toolName: name,
          args: input,
          executionKey: key,
        }));
        return run(toolName, args, projectPath, executionKey);
      },
      cancelSessionCalls: (executionKey) => canceled.push(executionKey),
    },
    ...(scheduleTimeout ? { scheduleTimeout } : {}),
  });
  return {
    relay,
    calls,
    canceled,
    invocations,
    setTools(value) { currentTools = value; },
  };
}

function executeRequest(overrides = {}) {
  return {
    executionId: "exec-1",
    sessionId: "session-1",
    turnId: "turn-1",
    toolCallId: "call-1",
    toolName: TOOL.fullName,
    args: { query: "notes" },
    ...overrides,
  };
}

test("advertises the active session catalog as a replacement without MCP credentials", async () => {
  const { relay, calls } = setup();
  await relay.addSession("session-1");
  await relay.addSession("session-2");

  assert.deepEqual(calls.map(({ method }) => method), ["tools/advertise", "tools/advertise"]);
  assert.deepEqual(calls[0].params, {
    sessionId: "session-1",
    tools: [{
      name: TOOL.fullName,
      description: TOOL.description,
      inputSchema: TOOL.schema,
      timeoutMs: 100_000,
      workspaceFree: true,
    }],
  });
  assert.equal(JSON.stringify(calls).includes("Authorization"), false);
  assert.equal(JSON.stringify(calls).includes("secret"), false);
});

test("a relay requires a paired owner and a Host toolRelay capability", async () => {
  for (const config of [
    { pairedDevice: false },
    { roles: ["controller"] },
    { toolRelay: false },
  ]) {
    const { relay, calls } = setup(config);
    await relay.addSession("session-1");
    assert.deepEqual(calls, []);
    await assert.rejects(
      relay.handleServerRequest("tool/execute", executeRequest()),
      /not authorized|unavailable/i,
    );
    relay.close();
  }
});

test("execution is bound to a known session, current tool schema, and bounded arguments", async () => {
  const executed = [];
  const { relay, invocations } = setup({ executeTool: async (...args) => {
    executed.push(args);
    return { answer: "found" };
  } });
  await relay.addSession("session-1");

  await assert.rejects(
    relay.handleServerRequest("tool/execute", executeRequest({ sessionId: "other-session" })),
    /session/i,
  );
  await assert.rejects(
    relay.handleServerRequest("tool/execute", executeRequest({ toolName: "mcp_other_search" })),
    /advertised|available/i,
  );
  await assert.rejects(
    relay.handleServerRequest("tool/execute", executeRequest({ args: { query: 42 } })),
    /arguments|schema/i,
  );
  await assert.rejects(
    relay.handleServerRequest("tool/execute", { ...executeRequest(), unexpected: true }),
    /invalid|request|contract/i,
  );

  const response = await relay.handleServerRequest("tool/execute", executeRequest());
  assert.deepEqual(response, { result: { answer: "found" }, isError: false });
  assert.equal(executed.length, 1);
  assert.equal(executed[0][0], TOOL.fullName);
  assert.deepEqual(executed[0][1], { query: "notes" });
  assert.equal(executed[0][2], null, "the Host workspace must not be used locally");
  assert.match(executed[0][3], /hostA/);
  assert.equal(invocations[0].projectPath, null);
  relay.close();
});

test("replacing the session catalog withdraws old names and rechecks source tools", async () => {
  const { relay, calls, setTools } = setup();
  await relay.addSession("session-1");
  setTools([]);
  await relay.refreshAll();

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].params, { sessionId: "session-1", tools: [] });
  await assert.rejects(
    relay.handleServerRequest("tool/execute", executeRequest()),
    /advertised|available/i,
  );
  relay.close();
});

test("oversized results and MCP failures become bounded tool errors", async () => {
  const tooLarge = "x".repeat(270 * 1024);
  const oversized = setup({ executeTool: async () => tooLarge });
  await oversized.relay.addSession("session-1");
  const oversizedResult = await oversized.relay.handleServerRequest("tool/execute", executeRequest());
  assert.equal(oversizedResult.isError, true);
  assert.ok(Buffer.byteLength(JSON.stringify(oversizedResult.result)) < 1024);
  oversized.relay.close();

  const failed = setup({ executeTool: async () => { throw new Error("secret-bearing server detail"); } });
  await failed.relay.addSession("session-1");
  const failedResult = await failed.relay.handleServerRequest("tool/execute", executeRequest());
  assert.equal(failedResult.isError, true);
  assert.equal(JSON.stringify(failedResult).includes("secret-bearing"), false);
  failed.relay.close();
});

test("timeout and disconnect cancel the exact in-flight MCP call", async () => {
  const timers = [];
  const started = [];
  const { relay, canceled } = setup({
    executeTool: async (_name, _args, _projectPath, executionKey) => new Promise(() => started.push(executionKey)),
    scheduleTimeout: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return () => { timer.cleared = true; };
    },
  });
  await relay.addSession("session-1");
  const timedOut = relay.handleServerRequest("tool/execute", executeRequest());
  for (let attempt = 0; started.length === 0 && attempt < 10; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(started.length, 1, "the advertised tool must start before its timeout is applied");
  assert.equal(timers[0].delayMs, 100_000);
  timers[0].callback();
  const timeoutResult = await timedOut;
  assert.equal(timeoutResult.isError, true);
  assert.deepEqual(canceled, [started[0]]);

  const disconnected = relay.handleServerRequest("tool/execute", executeRequest({ executionId: "exec-2" }));
  for (let attempt = 0; started.length < 2 && attempt < 10; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(started.length, 2, "the second advertised tool must start before disconnect");
  relay.disconnected();
  const disconnectResult = await disconnected;
  assert.equal(disconnectResult.isError, true);
  assert.deepEqual(canceled, [started[0], started[1]]);
  relay.close();
});
