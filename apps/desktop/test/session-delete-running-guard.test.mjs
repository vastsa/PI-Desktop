import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";
import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
import { IPC } from "../../../packages/shared/src/protocol.ts";

function load(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: path.resolve(file.pathname),
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}

/** The production promise-tail session operation, same semantics. */
function createSessionOperations() {
  const tails = new Map();
  return async function acquireSessionOperation(sessionId) {
    const id = sessionId.trim();
    const previous = tails.get(id) ?? Promise.resolve();
    let resolveCurrent;
    const current = new Promise((resolve) => { resolveCurrent = resolve; });
    const tail = previous.then(() => current);
    tails.set(id, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      resolveCurrent();
      if (tails.get(id) === tail) tails.delete(id);
    };
  };
}

function buildHarness({ hostCall, sidecarCall }) {
  const handlers = new Map();
  const acquireSessionOperation = createSessionOperations();
  const activeTurns = new Map();
  const dropped = [];
  const host = { call: (method, input) => hostCall(method, input) };
  const sidecar = sidecarCall
    ? { call: (method, input) => sidecarCall(method, input), clearProjectInstructionRoot() {}, clearVendorAuthBindings() {} }
    : null;
  const { registerSessionIpc } = load("../electron/main/ipc/session-ipc.ts", {
    electron: { shell: {} },
    "node:fs": fs,
    "node:path": path,
    "@pi-desktop/shared": { ErrorCodes, IPC },
    "../importers": {},
    "../services/session-collaboration": {},
    "../bootstrap/remote-hosts.js": { getActiveRemoteHostsBoot: () => null },
    "../services/session-search": {
      searchSessionsAcrossSources: async () => ({ hits: [], nextOffset: null }),
    },
  });
  registerSessionIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => sidecar,
    dataDir: "data-dir",
    activeTurns,
    sessionProjects: new Map(),
    persistenceOutbox: { dropSession: async (id) => dropped.push(id) },
    logger: { app() {} },
    plugins: { broadcastEvent() {} },
    sessionCapabilityContext: async () => ({ providers: [], defaults: {} }),
    enrichSession: (session) => session,
    acquireSessionOperation,
    beginTranscriptRewrite: async () => async () => undefined,
    forgetTranscriptRewriteHistory() {},
    stripWinLongPrefix: (value) => value,
    modeCatalog: {},
  });
  return { handlers, activeTurns, dropped, acquireSessionOperation };
}

const sessionDelete = (h, id) => h.handlers.get(IPC.invoke.sessionDelete)(id);

test("a session with a registered turn refuses deletion before the host is called", async () => {
  let deleteCalls = 0;
  const h = buildHarness({
    hostCall: async (method) => {
      if (method === "session.delete") {
        deleteCalls += 1;
        return { deleted: true };
      }
      return {};
    },
  });
  h.activeTurns.set("s1", "turn-1");
  await assert.rejects(
    sessionDelete(h, "s1"),
    (error) => error.errorCode === ErrorCodes.AGENT_BUSY &&
      /running session/.test(error.message),
  );
  assert.equal(deleteCalls, 0, "the host cascade never ran against a live turn");
  assert.deepEqual(h.dropped, []);
});

test("a turn registered while a prompt held the operation is still refused", async () => {
  // vastsa's repro: the prompt setup acquires the operation, registers its
  // durable turn, and releases; a delete issued afterwards must still see
  // the turn because the check now runs after acquiring.
  let deleteCalls = 0;
  const h = buildHarness({
    hostCall: async (method) => {
      if (method === "session.delete") {
        deleteCalls += 1;
        return { deleted: true };
      }
      return {};
    },
  });
  // Simulate the prompt's setup window: hold the operation, register the
  // turn, release.
  const releasePromptOperation = await h.acquireSessionOperation("s1");
  h.activeTurns.set("s1", "durable-turn");
  releasePromptOperation();
  await assert.rejects(
    sessionDelete(h, "s1"),
    (error) => error.errorCode === ErrorCodes.AGENT_BUSY,
  );
  assert.equal(deleteCalls, 0);
});

test("a delete holds the operation for its duration, so no turn can begin behind it", async () => {
  let releaseHost;
  let deleteCalls = 0;
  const h = buildHarness({
    hostCall: async (method) => {
      if (method === "session.delete") {
        deleteCalls += 1;
        await new Promise((resolve) => { releaseHost = resolve; });
        return { deleted: true };
      }
      return {};
    },
  });
  const deleting = sessionDelete(h, "s1");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deleteCalls, 1, "the host call started while the operation is held");
  assert.equal(typeof releaseHost, "function");
  releaseHost();
  const result = await deleting;
  assert.deepEqual(result, { deleted: true });
  assert.deepEqual(h.dropped, ["s1"], "the outbox drop follows the host cascade");
});

test("an idle session deletes cleanly and releases the operation", async () => {
  const h = buildHarness({
    hostCall: async (method) => (method === "session.delete" ? { deleted: true } : {}),
    sidecarCall: async (method) => {
      assert.equal(method, "agent.disposeSession");
      return {};
    },
  });
  const result = await sessionDelete(h, "s1");
  assert.deepEqual(result, { deleted: true });
  // The operation released: a second delete for another idle session works.
  const second = await sessionDelete(h, "s2");
  assert.deepEqual(second, { deleted: true });
});
