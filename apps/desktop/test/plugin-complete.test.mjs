import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");

register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { listReadyPluginModels, pluginCompleteContext, parsePluginModelKey } =
  await import("../electron/main/plugin-agent-complete.ts");

function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

function writePlugin({ permissions, main }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-complete-plugin-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "demo.complete",
      name: "Complete",
      version: "0.0.1",
      main: "main.js",
      permissions,
    }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), main, "utf8");
  return dir;
}

test("listReadyPluginModels omits providers without credentials", () => {
  const models = listReadyPluginModels([
    {
      id: "p1",
      name: "Ready",
      hasSecret: true,
      models: [{ id: "m1", thinkingLevels: ["off", "high"] }],
    },
    { id: "p2", name: "Locked", hasSecret: false, defaultModelId: "secret-model" },
  ]);
  assert.deepEqual(
    models.map((row) => row.key),
    ["p1/m1"],
  );
  assert.equal(parsePluginModelKey("p1/org/model")?.modelId, "org/model");
});

test("pluginCompleteContext serializes session context and appends the default tail", () => {
  const context = pluginCompleteContext({
    modelKey: "p1/m1",
    includeSessionContext: true,
    sessionContext: {
      sessionId: "s1",
      modelKey: "p1/fast",
      messages: [{ role: "user", content: "Ship it" }],
      truncated: false,
    },
  });
  assert.match(String(context.systemPrompt ?? ""), /^$/);
  assert.equal(context.messages.length, 2);
  assert.match(context.messages[0].content, /Ship it/);
  assert.match(context.messages[1].content, /respond/);
});

test("session context and complete stay bound to an in-flight tool call", async (t) => {
  const completes = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    listModels: async () => [
      {
        key: "prov/model",
        providerId: "prov",
        providerName: "Prov",
        modelId: "model",
        label: "model (Prov)",
        supportsReasoning: true,
        thinkingLevels: ["off", "high"],
      },
    ],
    getSessionContext: async (sessionId, stripToolName) => ({
      sessionId,
      modelKey: "prov/fast",
      thinkingLevel: "low",
      messages: [{ role: "user", content: "context for " + stripToolName }],
      truncated: false,
    }),
    complete: async (input) => {
      completes.push(input);
      return { text: "ship smaller", modelKey: input.modelKey, thinkingLevel: "high" };
    },
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });

  const dir = writePlugin({
    permissions: ["agent.tool.register", "models.list", "session.read", "agent.complete"],
    main: `
      module.exports = {
        async onLoad() {
          await pi.agent.registerTool({
            name: "review",
            description: "review",
            schema: { type: "object", properties: {} },
            execute: async () => {
              const models = await pi.models.list();
              const context = await pi.session.getLlmContext();
              const result = await pi.agent.complete({
                modelKey: "prov/model",
                includeSessionContext: true,
              });
              return { models: models.map((row) => row.key), context, result };
            },
          });
          await pi.commands.register({
            id: "peek",
            title: "Peek",
            run: async () => {
              await pi.session.getLlmContext();
            },
          });
        },
      };
    `,
  });
  await runtime.loadFromPath(dir, [
    "agent.tool.register",
    "models.list",
    "session.read",
    "agent.complete",
  ]);

  const peek = runtime.getCommands().find((command) => command.id === "peek");
  await assert.rejects(() => peek.run(), /session context is only available during tool execution/);

  const tool = runtime.getTools().find((entry) => entry.name === "review");
  const output = await tool.execute({}, { sessionId: "sess-1" });
  assert.deepEqual(output.models, ["prov/model"]);
  assert.equal(output.context.sessionId, "sess-1");
  assert.match(output.context.messages[0].content, /plugin_demo_complete_review/);
  assert.equal(output.result.text, "ship smaller");
  assert.equal(completes[0].includeSessionContext, true);
  assert.equal(completes[0].sessionId, "sess-1");
  assert.equal(typeof completes[0].signal?.aborted, "boolean");
});

test("agent.complete is rate-limited per plugin", async (t) => {
  let calls = 0;
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    complete: async (input) => {
      calls += 1;
      return { text: "ok", modelKey: input.modelKey };
    },
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  const dir = writePlugin({
    permissions: ["agent.tool.register", "agent.complete"],
    main: `
      module.exports = {
        async onLoad() {
          await pi.agent.registerTool({
            name: "burn",
            description: "burn",
            schema: { type: "object", properties: {} },
            execute: async () => {
              const errors = [];
              for (let i = 0; i < 9; i++) {
                try {
                  await pi.agent.complete({ modelKey: "prov/model", messages: [{ role: "user", content: "x" }] });
                } catch (error) {
                  errors.push(error.code || error.message);
                }
              }
              return { errors };
            },
          });
        },
      };
    `,
  });
  await runtime.loadFromPath(dir, ["agent.tool.register", "agent.complete"]);
  const tool = runtime.getTools().find((entry) => entry.name === "burn");
  const output = await tool.execute({}, { sessionId: "s" });
  assert.equal(calls, 8);
  assert.ok(output.errors.some((entry) => String(entry).includes("RATE_LIMITED") || String(entry).includes("rate")));
});
