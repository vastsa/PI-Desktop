import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
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

test("the plugin model catalog projects aliases and explicit delegation opt-in", () => {
  const models = listReadyPluginModels([
    {
      id: "ready",
      name: "Ready provider",
      hasSecret: true,
      models: [
        { id: "org/fast", alias: " Quick review ", availableForSubagents: true },
        { id: "private", alias: "  ", availableForSubagents: false },
        { id: "not-opted-in" },
      ],
    },
    { id: "disabled", name: "Disabled", enabled: false, hasSecret: true, defaultModelId: "hidden" },
    { id: "locked", name: "Locked", models: [{ id: "hidden", availableForSubagents: true }] },
  ]);
  assert.deepEqual(models.map(({ key, alias, availableForSubagents }) => ({ key, alias, availableForSubagents })), [
    { key: "ready/org/fast", alias: "Quick review", availableForSubagents: true },
    { key: "ready/private", alias: undefined, availableForSubagents: false },
    { key: "ready/not-opted-in", alias: undefined, availableForSubagents: false },
  ]);
  assert.equal(models[0].label, "org/fast (Ready provider)");
});

test("only the configured provider and model are marked as the default", () => {
  const models = listReadyPluginModels([
    { id: "first", name: "First", authKind: "none", models: [{ id: "fast" }, { id: "chosen" }] },
    { id: "selected", name: "Selected", hasOauth: true, models: [{ id: "fast" }, { id: "chosen" }, { id: "chosen" }] },
  ], { defaultProviderId: "selected", defaultModelId: "chosen" });
  assert.deepEqual(models.filter((model) => model.isDefault).map((model) => model.key), ["selected/chosen"]);
  assert.equal(models.find((model) => model.isDefault).availableForSubagents, false);
});

test("default fallback matches enabled ready provider order and the first binding", () => {
  const providers = [
    { id: "disabled", name: "Disabled", enabled: false, hasSecret: true, defaultModelId: "unused" },
    { id: "locked", name: "Locked", defaultModelId: "unused" },
    { id: "ready", name: "Ready", authKind: "none", defaultModelId: "legacy", models: [{ id: "first" }, { id: "next" }] },
    { id: "later", name: "Later", hasSecret: true, defaultModelId: "later" },
  ];
  for (const settings of [{}, { defaultProviderId: "deleted", defaultModelId: "unused" }]) {
    const models = listReadyPluginModels(providers, settings);
    assert.deepEqual(models.filter((model) => model.isDefault).map((model) => model.key), ["ready/first"]);
  }
  const legacy = listReadyPluginModels([
    { id: "legacy", name: "Legacy", hasSecret: true, defaultModelId: "old-model", supportedThinkingLevels: ["off", "high"] },
  ]);
  assert.equal(legacy[0].key, "legacy/old-model");
  assert.equal(legacy[0].isDefault, true);
  assert.equal(legacy[0].availableForSubagents, false);
  assert.equal(legacy[0].supportsReasoning, true);
});

test("unavailable configured defaults do not silently label another model as default", () => {
  const providers = [
    { id: "locked", name: "Locked", defaultModelId: "unavailable" },
    { id: "ready", name: "Ready", hasSecret: true, models: [{ id: "real-model" }] },
  ];
  for (const settings of [
    { defaultProviderId: "locked", defaultModelId: "unavailable" },
    { defaultProviderId: "ready", defaultModelId: "removed-model" },
  ]) {
    const models = listReadyPluginModels(providers, settings);
    assert.deepEqual(models.map((model) => model.key), ["ready/real-model"]);
    assert.equal(models.some((model) => model.isDefault), false);
  }
});

test("explicit binding thinking levels take precedence over provider reasoning support", () => {
  const models = listReadyPluginModels([{
    id: "reasoning",
    name: "Reasoning provider",
    hasSecret: true,
    supportsReasoning: true,
    supportedThinkingLevels: ["off", "high"],
    models: [
      { id: "off", thinkingLevels: ["off"] },
      { id: "empty", thinkingLevels: [] },
      { id: "high", thinkingLevels: ["high"] },
      { id: "inherit" },
    ],
  }]);
  assert.deepEqual(models.map((model) => model.supportsReasoning), [false, false, true, true]);
  assert.deepEqual(models.map((model) => model.thinkingLevels), [["off"], [], ["high"], ["off", "high"]]);
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

test("agent.complete keeps the classified provider code for the plugin", async (t) => {
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    complete: async () => {
      // Exactly the shape `completeOneShot` throws: `errorCode` (+ `data.errorCode`),
      // never `code`. A plugin must be able to tell a rate limit from a network fault.
      throw Object.assign(new Error("429: provider rate limited"), {
        errorCode: "PROVIDER_RATE_LIMITED",
        data: { retriable: true, errorCode: "PROVIDER_RATE_LIMITED" },
      });
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
            name: "ask",
            description: "ask",
            schema: { type: "object", properties: {} },
            execute: async () => {
              try {
                await pi.agent.complete({
                  modelKey: "prov/model",
                  messages: [{ role: "user", content: "x" }],
                });
                return { code: null, message: null };
              } catch (error) {
                return { code: error.code || null, message: error.message || null };
              }
            },
          });
        },
      };
    `,
  });
  await runtime.loadFromPath(dir, ["agent.tool.register", "agent.complete"]);
  const tool = runtime.getTools().find((entry) => entry.name === "ask");
  const output = await tool.execute({}, { sessionId: "s" });
  assert.equal(output.code, "PROVIDER_RATE_LIMITED");
  assert.match(output.message, /429/);
});

test("the plugin completion declares INVALID_ARGUMENT for empty model output", async () => {
  const source = await readFile(
    new URL("../electron/main/services/plugin-services.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /emptyErrorCode: "INVALID_ARGUMENT"/);
});
