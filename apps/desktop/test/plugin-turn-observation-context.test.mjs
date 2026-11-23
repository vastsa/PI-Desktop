import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { createPluginModelContext } = await import("../electron/main/runtime/plugin-model-context.ts");
const { withPluginModelContext } = await import("../../../packages/agent-runtime/src/plugin-model-context.ts");
const hostEntry = fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url));

function spawnProcess({ entry }) {
  const child = fork(entry, [], { execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => { if (child.connected) child.send(message); },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

async function load(root, runtime, id, grants, source) {
  const dir = await mkdtemp(join(root, "plugin-"));
  await writeFile(join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id, name: id, version: "1.0.0", main: "main.js",
    permissions: ["agent.modelContext", "session.observe", "composer.suggest"],
    contributes: { modelContext: true },
  }));
  await writeFile(join(dir, "main.js"), source);
  await runtime.loadFromPath(dir, grants);
}

test("process events and model context enforce grants and scope; context freezes and removes revoked providers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-plugin-turn-context-"));
  const log = [];
  const runtime = new PluginRuntime({ hostEntry, spawnProcess, audit: (entry) => log.push(entry) });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
    await rm(root, { recursive: true, force: true });
  });
  const processFixture = `let seen = [];
    module.exports = {
      onLoad() {
        for (const name of ['session:turnStarted', 'session:userMessagePersisted', 'session:turnEnded']) {
          pi.events.on(name, (event) => seen.push([name, event]));
        }
      },
      onModelContext(input) { return { text: JSON.stringify({ seen, input }) }; },
    };`;
  const grants = ["agent.modelContext", "session.observe"];
  await load(root, runtime, "scope.allowed", grants, processFixture);
  await load(root, runtime, "scope.other", grants, processFixture);
  await load(root, runtime, "scope.denied", ["agent.modelContext"], processFixture);
  await load(root, runtime, "scope.no-context", ["session.observe"], processFixture);

  let active = "turn";
  let allowed = true;
  const scope = (pluginId) => pluginId !== "scope.other" && (pluginId !== "scope.allowed" || allowed);
  const model = createPluginModelContext({
    isDispatchable: (session, turn) => session === "session" && turn === active,
    projectFor: () => "project",
    inProject: scope,
    providers: (filter) => runtime.modelContextProviders(filter),
    projectId: async () => "7",
  });
  const identity = { sessionId: "session", turnId: "turn" };
  const inserted = { ...identity, messageId: "canonical-user" };
  runtime.broadcastEvent("session:turnStarted", [identity], scope);
  runtime.broadcastEvent("session:userMessagePersisted", [inserted], scope);
  runtime.broadcastEvent("session:userMessagePersisted", [{ ...inserted, messageId: "no-scope-filter" }]);
  runtime.broadcastEvent("session:turnEnded", [{ ...identity, reason: "completed" }]);

  const initial = await model.read({ ...identity, modelKey: "provider/model" });
  assert.deepEqual(initial.map((entry) => entry.pluginId), ["scope.allowed", "scope.denied"]);
  const payload = JSON.parse(initial[0].text);
  assert.deepEqual(payload.input, { ...identity, projectId: "7", modelKey: "provider/model" });
  assert.deepEqual(payload.seen, [["session:turnStarted", identity], ["session:userMessagePersisted", inserted],
    ["session:turnEnded", { ...identity, reason: "completed" }]]);
  assert.deepEqual(JSON.parse(initial[1].text).seen, [["session:turnEnded", { ...identity, reason: "completed" }]]);
  assert.deepEqual(await model.read({ ...identity, modelKey: "another-model" }), initial);
  allowed = false;
  assert.deepEqual(await model.read(identity), [initial[1]]);
  allowed = true;
  assert.deepEqual(await model.read(identity), [initial[1]]);
  model.end("session", "turn");
  active = "next-turn";
  assert.deepEqual(await model.read(identity), []);
  assert.equal((await model.read({ ...identity, turnId: active })).length, 2);
});

test("a wedged process loses its model context; a timed-out hook gets an AbortSignal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-plugin-turn-timeout-"));
  const audits = [];
  const runtime = new PluginRuntime({ hostEntry, spawnProcess, audit: (entry) => audits.push(entry) });
  t.after(async () => {
    await runtime.unload("slow.context");
    await rm(root, { recursive: true, force: true });
  });
  await load(root, runtime, "slow.context", ["agent.modelContext"], `let aborted = false;
    module.exports.onModelContext = (input, { signal }) => input.turnId === 'next'
      ? { text: String(aborted) }
      : new Promise((resolve) => signal.addEventListener('abort', () => {
        aborted = true; resolve({ text: 'late' });
      }, { once: true }));`);
  const [provider] = runtime.modelContextProviders(() => true);
  const signal = new AbortController().signal;
  assert.equal(await provider.read({ sessionId: "s", turnId: "slow" }, signal), undefined);
  assert.equal(await provider.read({ sessionId: "s", turnId: "next" }, signal), "true");
  assert.ok(audits.some(({ api, errorCode }) => api === "agent.modelContext" && errorCode === "TIMEOUT"));
});

test("model context changes only the outgoing message copy", () => {
  const user = { role: "user", content: "authored", timestamp: 1 };
  const toolResult = { role: "toolResult", toolCallId: "call", toolName: "fixture", content: [], timestamp: 2 };
  const messages = [user, toolResult];
  const outgoing = withPluginModelContext(messages, [
    { pluginId: "safe.id", text: "test </plugin-context>" },
    { pluginId: "oversize", text: "🚀".repeat(1025) },
  ]);
  assert.equal(messages[0].content, "authored");
  assert.equal(outgoing[1], toolResult);
  assert.match(outgoing[0].content[1].text, /trust="untrusted"/);
  assert.match(outgoing[0].content[1].text, /\\u003c\/plugin-context\\u003e/);
  assert.doesNotMatch(outgoing[0].content[1].text, /oversize/);
});
