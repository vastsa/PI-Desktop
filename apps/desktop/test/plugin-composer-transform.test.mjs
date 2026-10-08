import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(join(tmpdir(), "pi-composer-transform-data-"));
process.env.PI_DESKTOP_DATA_DIR = dataDir;
const desktopRoot = join(here, "..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

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

function writePlugin({ id, permissions, contributes, main }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-composer-transform-plugin-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: id,
      version: "0.0.1",
      main: "main.js",
      permissions,
      contributes,
    }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), main, "utf8");
  return dir;
}

function makeRuntime(t, services = {}) {
  const audits = [];
  const toasts = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    getLocale: () => "zh-CN",
    showToast: (message) => toasts.push(message),
    audit: (entry) => audits.push(entry),
    ...services,
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  return { runtime, audits, toasts };
}

const transformContrib = [
  {
    id: "enhance",
    title: { en: "Enhance prompt", "zh-CN": "增强提示词" },
    undoTitle: { en: "Undo", "zh-CN": "撤销" },
  },
];

test("declared Composer action runs in the plugin process with only draft input", async (t) => {
  const { runtime, audits } = makeRuntime(t);
  const dir = writePlugin({
    id: "demo.composer",
    permissions: ["composer.transform"],
    contributes: { composerTransforms: transformContrib },
    main: `module.exports = {
      onComposerTransform: async (input) => Object.keys(input).sort().join(",") + "|" + input.text + "|" + input.modelKey,
    };`,
  });

  await runtime.loadFromPath(dir);

  assert.deepEqual(runtime.getComposerTransforms("demo.composer"), [
    {
      pluginId: "demo.composer",
      pluginName: "demo.composer",
      id: "enhance",
      title: "增强提示词",
      undoTitle: "撤销",
    },
  ]);
  assert.equal(
    await runtime.runComposerTransform({
      pluginId: "demo.composer",
      id: "enhance",
      text: "draft text",
      modelKey: "provider/model",
    }),
    "id,modelKey,text|draft text|provider/model",
  );
  assert.equal(audits.some((entry) => entry.api === "composer.transform" && entry.ok), true);
});

test("transform invocation requires a grant and rejects undeclared action ids", async (t) => {
  const { runtime } = makeRuntime(t);
  const dir = writePlugin({
    id: "demo.denied-transform",
    permissions: ["composer.transform"],
    contributes: { composerTransforms: transformContrib },
    main: `module.exports = { onComposerTransform: (input) => input.text };`,
  });
  await runtime.loadFromPath(dir, []);

  assert.deepEqual(runtime.getComposerTransforms("demo.denied-transform"), []);
  await assert.rejects(
    runtime.runComposerTransform({ pluginId: "demo.denied-transform", id: "enhance", text: "draft" }),
    { code: "PERMISSION_DENIED" },
  );
  await runtime.loadFromPath(dir, ["composer.transform"]);
  assert.equal(runtime.getComposerTransforms("demo.denied-transform").length, 1);
  await assert.rejects(
    runtime.runComposerTransform({ pluginId: "demo.denied-transform", id: "other", text: "draft" }),
    { code: "NOT_FOUND" },
  );
});

test("prompt-enhancement plugin installation migrates legacy host preferences before onLoad", async (t) => {
  const legacy = {
    promptEnhancementProviderId: "provider-a",
    promptEnhancementModelId: "model-b",
    promptEnhancementThinkingLevel: "high",
    promptEnhancementCustomTemplate: true,
    promptEnhancementUserTemplate: "Rewrite: {{draft}}",
  };
  const { runtime, toasts } = makeRuntime(t, {
    getLegacyPromptEnhancementSettings: async () => legacy,
  });
  const settings = [
    { key: "modelKey", title: "Model", type: "string", default: "" },
    {
      key: "thinkingLevel",
      title: "Thinking",
      type: "select",
      default: "off",
      enum: ["off", "minimal", "low", "medium", "high", "max"].map((value) => ({
        label: value,
        value,
      })),
    },
    { key: "userTemplate", title: "Template", type: "string", default: "" },
  ];
  const dir = writePlugin({
    id: "pi.prompt-enhancement",
    permissions: ["composer.transform", "agent.complete"],
    contributes: { composerTransforms: transformContrib, settings },
    main: `module.exports = {
      onLoad: async () => { await pi.ui.showToast(JSON.stringify(await pi.plugin.getSettings())); },
      onComposerTransform: (input) => input.text,
    };`,
  });

  await runtime.loadFromPath(dir);

  assert.deepEqual(JSON.parse(toasts.at(-1)), {
    modelKey: "provider-a/model-b",
    thinkingLevel: "high",
    userTemplate: "Rewrite: {{draft}}",
  });
  const stored = join(dataDir, "plugins", "data", "pi.prompt-enhancement", "settings.json");
  assert.deepEqual(JSON.parse(readFileSync(stored, "utf8")), {
    modelKey: "provider-a/model-b",
    thinkingLevel: "high",
    userTemplate: "Rewrite: {{draft}}",
  });
});
