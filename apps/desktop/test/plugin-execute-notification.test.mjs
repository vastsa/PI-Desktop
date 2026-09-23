import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { dirname, join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { createHostRuntime } = await import("../electron/main/runtime/host.ts");
const { createSessionCoordination } = await import(
  "../electron/main/runtime/session-coordination.ts"
);

// `plugins.execute` crosses a language boundary: host-core writes the payload in
// Rust, the main process reads it back by field name, and nothing type-checks the
// two against each other. A field dropped from the Rust side is invisible to
// every other check — the receiver throws on the first missing name, the tool
// never runs, and host-core waits out its RPC timeout. So read the field list
// from the Rust source and drive the real receiver with it.
const rustSource = readFileSync(
  join(here, "..", "..", "..", "crates", "host-core", "src", "rpc", "mod.rs"),
  "utf8",
);

/**
 * Field names of the `plugins.execute` notification payload, taken from the
 * `json!({ ... })` literal in host-core. Brace matching ignores nesting; the
 * payload holds no braces inside strings or comments, so a simple depth count is
 * enough and any future nesting still keeps the top-level names correct.
 */
function pluginExecutePayloadFields(source) {
  const notification = source.indexOf('"plugins.execute"');
  assert.ok(notification >= 0, "the plugins.execute notification is gone");
  const literal = source.indexOf("json!({", notification);
  assert.ok(literal >= 0, "the plugins.execute payload literal is gone");
  const open = source.indexOf("{", literal);
  let depth = 0;
  let end = -1;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  assert.ok(end > open, "the plugins.execute payload literal is unbalanced");
  return [...source.slice(open + 1, end).matchAll(/^\s*"([A-Za-z][A-Za-z0-9]*)":/gm)].map(
    (match) => match[1],
  );
}

const FIELDS = pluginExecutePayloadFields(rustSource);

const SESSION_ID = "session-1";
const TURN_ID = "turn-1";

const VALUE_BY_FIELD = {
  executionId: "exec-1",
  permitToken: "permit-1",
  sessionId: SESSION_ID,
  turnId: TURN_ID,
  toolCallId: "call-1",
  toolName: "demo_echo",
  args: { message: "hello" },
  mode: "agent",
  planSafeActions: [],
};

const TOOL_NAME = VALUE_BY_FIELD.toolName;

/**
 * The dispatch gate is the real coordination instance in the main process, and
 * whether a call may run depends on the identity it carries, so the fixture
 * builds the real instance instead of stubbing `isTurnDispatchable`: a stub would
 * decide that question itself. `activeTurn` seeds the session's live turn;
 * leaving it out models a session whose turn has already ended.
 */
function fixture({ activeTurn, denyPermit = false } = {}) {
  const calls = [];
  const invocations = [];
  const mcpInvocations = [];
  let notification = null;

  const activeTurns = new Map();
  if (activeTurn !== undefined) activeTurns.set(SESSION_ID, activeTurn);
  const coordination = createSessionCoordination({
    activeTurns,
    getMainWindow: () => null,
    getViewingSessionId: () => null,
  });

  const host = {
    onNotification: (handler) => {
      notification = handler;
    },
    onExit() {},
    async call(method, params) {
      calls.push({ method, params });
      if (method === "permissions.consumeExecutionPermit" && denyPermit) {
        throw Object.assign(new Error("authorization stale"), { errorCode: "AUTHORIZATION_STALE" });
      }
      return {};
    },
  };

  const runtime = createHostRuntime({
    // The notification handler ignores anything from a host generation that is
    // no longer current, so the fake must be the live one.
    runtimeState: { host, sidecar: null, agentHostBridge: null },
    dataDir: "/tmp/pi-desktop-test",
    logger: { app() {}, child: () => ({ app() {} }), flushChild() {} },
    persistenceOutbox: { size: () => 0, flush: async () => undefined },
    activeToolCalls: new Map(),
    activeToolCallKey: (sessionId, toolCallId) => `${sessionId}:${toolCallId}`,
    sessionProjects: new Map(),
    plugins: {
      getTools: () => [
        {
          fullName: TOOL_NAME,
          pluginId: "demo",
          execute: async (args, ctx) => {
            invocations.push({ args, ctx });
            return { echoed: true };
          },
        },
      ],
      drainToasts: () => [],
    },
    userMcp: { callTool: async (...args) => { mcpInvocations.push(args); return null; } },
    pluginActiveInProject: () => true,
    sendToRenderer() {},
    emitAgentEvent() {},
    togglePluginLauncher: async () => undefined,
    finishTurn: async () => undefined,
    isTurnDispatchable: coordination.isTurnDispatchable,
    finishApprovedExecution: async () => undefined,
    activeTurns,
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    importLegacyScheduled: async () => undefined,
    superviseRestart: async () => undefined,
    isQuitting: () => false,
  });
  runtime.wireHost(host);

  return {
    calls,
    invocations,
    mcpInvocations,
    notify: (method, params) => notification(method, params),
  };
}

function fullPayload() {
  return Object.fromEntries(FIELDS.map((field) => [field, VALUE_BY_FIELD[field]]));
}

function payloadWithout(missing) {
  return Object.fromEntries(
    FIELDS.filter((field) => field !== missing).map((field) => [field, VALUE_BY_FIELD[field]]),
  );
}

async function dispatch(f, payload) {
  f.notify("plugins.execute", payload);
  await setImmediate();
  await setImmediate();
  return f.calls.filter((call) => call.method === "plugins.resolveExecution");
}

function assertRefused(resolved, expectedExecutionId) {
  assert.equal(resolved.length, 1, "host-core must be answered exactly once");
  assert.equal(resolved[0].params.ok, false, "the call must be refused");
  assert.equal(resolved[0].params.errorCode, "TOOL_TURN_CANCELLED");
  assert.equal(resolved[0].params.executionId, expectedExecutionId);
}

test("the host-core notification carries every field the receiver reads", () => {
  for (const field of ["executionId", "permitToken", "sessionId", "toolCallId", "toolName", "args", "turnId", "mode"]) {
    assert.ok(FIELDS.includes(field), `plugins.execute no longer sends ${field}`);
  }
  assert.equal(
    FIELDS.filter((field) => field === "turnId").length,
    1,
    "the turn identity must be sent exactly once",
  );
});

test("the live turn's payload runs the plugin tool and is answered", async () => {
  const f = fixture({ activeTurn: TURN_ID });
  const payload = fullPayload();

  const resolved = await dispatch(f, payload);

  assert.equal(resolved.length, 1, "host-core must be answered exactly once");
  assert.equal(
    resolved[0].params.ok,
    true,
    `the tool must run: ${JSON.stringify(resolved[0].params)}`,
  );
  assert.equal(resolved[0].params.executionId, payload.executionId);

  assert.equal(f.invocations.length, 1, "the plugin tool must be executed once");
  assert.equal(f.calls[0].method, "permissions.consumeExecutionPermit");
  assert.equal(f.calls[0].params.permitToken, payload.permitToken);
  assert.deepEqual(f.invocations[0].args, payload.args);
  // The turn identity travels with the call, so a plugin can scope the work it
  // started to the turn `session:turnEnded` will name.
  assert.equal(f.invocations[0].ctx.turnId, payload.turnId);
  assert.equal(f.invocations[0].ctx.sessionId, payload.sessionId);
});

// A turn that no longer owns the session was already settled: its cancel lock is
// gone and its `session:turnEnded` has been announced, so nothing may start work
// on its behalf. The refusal is answered on the original execution id, otherwise
// host-core waits out its RPC timeout.
test("a payload naming a turn that no longer owns the session is refused", async () => {
  const f = fixture({ activeTurn: "turn-elsewhere" });
  const payload = fullPayload();

  assertRefused(await dispatch(f, payload), payload.executionId);
  assert.equal(f.invocations.length, 0, "a settled turn must not start a plugin side effect");
});

test("a payload for a turn that already ended is refused", async () => {
  // No live turn at all: the session's record was released when its
  // `session:turnEnded` went out.
  const f = fixture();
  const payload = fullPayload();

  assertRefused(await dispatch(f, payload), payload.executionId);
  assert.equal(f.invocations.length, 0);
});

// host-core types the turn identity as optional (`ToolsExecuteParams.turn_id`),
// but a call that names no turn cannot be attributed to one: main cannot tell it
// apart from a call belonging to a turn that already ended, and any resource it
// started could never be related to that turn's `session:turnEnded`. So the gate
// stays closed and the caller gets a failure instead of a silent new turn.
test("a payload without a turn identity is refused rather than executed", async () => {
  // The session's turn is live on purpose: the refusal must come from the missing
  // identity, not from an idle session.
  const f = fixture({ activeTurn: TURN_ID });
  const payload = payloadWithout("turnId");

  assertRefused(await dispatch(f, payload), payload.executionId);
  assert.equal(
    f.invocations.length,
    0,
    "a call that names no turn must not start a plugin side effect",
  );
});

test("a payload without a session identity is refused on the same grounds", async () => {
  const f = fixture({ activeTurn: TURN_ID });
  const payload = payloadWithout("sessionId");

  assertRefused(await dispatch(f, payload), payload.executionId);
  assert.equal(f.invocations.length, 0);
});

test("an mcprefixed tool keeps its own path", async () => {
  const f = fixture({ activeTurn: TURN_ID });
  const payload = { ...fullPayload(), toolName: "mcp_demo" };

  const resolved = await dispatch(f, payload);

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].params.ok, true);
  assert.equal(f.calls[0].method, "permissions.consumeExecutionPermit");
  assert.equal(f.mcpInvocations.length, 1);
  assert.equal(f.invocations.length, 0, "an mcp tool never reaches the plugin runtime");
});

test("stale execution permits prevent plugin and MCP side effects", async () => {
  for (const toolName of [TOOL_NAME, "mcp_demo"]) {
    const f = fixture({ activeTurn: TURN_ID, denyPermit: true });
    const resolved = await dispatch(f, { ...fullPayload(), toolName });
    assert.equal(f.calls[0].method, "permissions.consumeExecutionPermit");
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].params.ok, false);
    assert.equal(f.invocations.length, 0);
    assert.equal(f.mcpInvocations.length, 0);
  }
});
