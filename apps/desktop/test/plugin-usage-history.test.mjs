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
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-plugin-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "demo.usage",
      name: "Usage",
      version: "0.0.1",
      main: "main.js",
      permissions,
    }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), main, "utf8");
  return dir;
}

const USAGE_TOOL_MAIN = `
  module.exports = {
    async onLoad() {
      await pi.agent.registerTool({
        name: "usage",
        description: "usage",
        schema: { type: "object", properties: {} },
        execute: async () => {
          try {
            const history = await pi.session.getUsageHistory({ bucket: "day" });
            return { history };
          } catch (error) {
            return { denied: error.code || error.message };
          }
        },
      });
    },
  };
`;

test("session.getUsageHistory returns host usage history with the permission", async (t) => {
  const calls = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    session: {
      getUsageHistory: async (pluginId, input) => {
        calls.push({ pluginId, input });
        return {
          bucket: "day",
          rangeStart: 0,
          rangeEnd: 1,
          items: [],
          totals: { inputTokens: 3, outputTokens: 2, totalTokens: 5, turnCount: 1 },
        };
      },
    },
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });

  const dir = writePlugin({
    permissions: ["agent.tool.register", "session.usage.read"],
    main: USAGE_TOOL_MAIN,
  });
  await runtime.loadFromPath(dir, ["agent.tool.register", "session.usage.read"]);

  const tool = runtime.getTools().find((entry) => entry.name === "usage");
  const output = await tool.execute({}, { sessionId: "s" });
  assert.equal(output.denied, undefined);
  assert.equal(output.history.totals.totalTokens, 5);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pluginId, "demo.usage");
  assert.equal(calls[0].input.bucket, "day");
});

test("session.getUsageHistory is denied without the session.usage.read permission", async (t) => {
  let calls = 0;
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    session: {
      getUsageHistory: async () => {
        calls += 1;
        return {};
      },
    },
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });

  const dir = writePlugin({
    permissions: ["agent.tool.register"],
    main: USAGE_TOOL_MAIN,
  });
  await runtime.loadFromPath(dir, ["agent.tool.register"]);

  const tool = runtime.getTools().find((entry) => entry.name === "usage");
  const output = await tool.execute({}, { sessionId: "s" });
  assert.equal(calls, 0);
  assert.match(String(output.denied), /PERMISSION_DENIED|missing permission/);
});
