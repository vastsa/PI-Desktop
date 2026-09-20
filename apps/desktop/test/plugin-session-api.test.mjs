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
    postMessage: (message) => child.connected && child.send(message),
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

function writePlugin({ id, permissions, main, sessionSources = [{ id: "legacy" }] }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-session-plugin-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: id,
      version: "0.0.1",
      main: "main.js",
      permissions,
      contributes: { sessionSources },
    }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), main, "utf8");
  return dir;
}

async function runCommand(runtime, id) {
  const command = runtime.getCommands().find((entry) => entry.id === id);
  assert.ok(command, `command not registered: ${id}`);
  await command.run();
}

test("plugin session API enforces own permissions and declared sources", async (t) => {
  const calls = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    session: {
      list: async (pluginId, input) => {
        calls.push(["list", pluginId, input]);
        return { items: [] };
      },
      get: async () => ({ sessionId: "s1" }),
      listMessages: async () => ({ items: [] }),
      import: async (pluginId, input) => {
        calls.push(["import", pluginId, input]);
        return { sessionId: "host-generated", imported: true, skipped: false };
      },
      importBatch: async () => ({ results: [], imported: 0, skipped: 0, failed: 0 }),
      rename: async () => ({ updated: true }),
      delete: async () => ({ deleted: true }),
    },
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });

  const dir = writePlugin({
    id: "demo.session",
    permissions: ["session.import", "session.read.own"],
    main: `
      module.exports = {
        async onLoad() {
          await pi.commands.register({
            id: "exercise",
            title: "Exercise",
            run: async () => {
              await pi.session.import({
                source: "legacy",
                externalId: "external-1",
                title: "Imported",
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:01Z",
                messages: [{ role: "user", content: "hello", createdAt: "2026-01-01T00:00:00Z" }]
              });
              await pi.session.list({ source: "legacy" });
              try { await pi.session.list({ source: "undeclared" }); }
              catch (error) { await pi.ui.showToast("source:" + error.code); }
            }
          });
        }
      };
    `,
  });
  await runtime.loadFromPath(dir, ["session.import", "session.read.own"]);
  await runCommand(runtime, "exercise");
  assert.equal(calls[0][0], "import");
  assert.equal(calls[0][1], "demo.session");
  assert.equal(calls[0][2].sourceLabel, "legacy");
  assert.deepEqual(calls[1], ["list", "demo.session", { source: "legacy" }]);
  assert.match(runtime.drainToasts().at(-1) ?? "", /source:PERMISSION_DENIED/);
});

test("plugin session payload validation rejects invalid roles before host dispatch", async (t) => {
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    session: {
      import: async () => {
        throw new Error("host should not receive invalid input");
      },
    },
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  const dir = writePlugin({
    id: "demo.invalid-session",
    permissions: ["session.import"],
    main: `
      module.exports = {
        async onLoad() {
          await pi.commands.register({
            id: "invalid",
            title: "Invalid",
            run: async () => {
              try {
                await pi.session.import({
                  source: "legacy",
                  externalId: "bad",
                  title: "Bad",
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-01T00:00:01Z",
                  messages: [{ role: "system", content: "no", createdAt: "2026-01-01T00:00:00Z" }]
                });
              } catch (error) { await pi.ui.showToast(error.code); }
              try { await pi.session.import("not-an-object"); }
              catch (error) { await pi.ui.showToast("shape:" + error.code); }
            }
          });
        }
      };
    `,
  });
  await runtime.loadFromPath(dir, ["session.import"]);
  await runCommand(runtime, "invalid");
  assert.deepEqual(runtime.drainToasts(), ["INVALID_PARAMS", "shape:INVALID_PARAMS"]);
});

test("plugin can explicitly create a project id and import into it", async (t) => {
  const calls = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    project: {
      create: async (pluginId, input) => {
        calls.push(["project", pluginId, input]);
        return { projectId: 7, path: input.path, name: "Imported project" };
      },
    },
    session: {
      import: async (pluginId, input) => {
        calls.push(["import", pluginId, input]);
        return { sessionId: "bound-session", imported: true, skipped: false };
      },
    },
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  const dir = writePlugin({
    id: "demo.project-import",
    permissions: ["project.create", "session.import"],
    main: `
      module.exports = {
        async onLoad() {
          await pi.commands.register({
            id: "bind",
            title: "Bind",
            run: async () => {
              const project = await pi.project.create({ path: "/tmp/imported-project" });
              await pi.session.import({
                source: "legacy",
                externalId: "bound-1",
                title: "Bound",
                projectId: project.projectId,
                createdAt: "2026-01-01T00:00:00Z",
                updatedAt: "2026-01-01T00:00:01Z",
                messages: [{ role: "user", content: "hello", createdAt: "2026-01-01T00:00:00Z" }]
              });
            }
          });
        }
      };
    `,
  });
  await runtime.loadFromPath(dir, ["project.create", "session.import"]);
  await runCommand(runtime, "bind");
  assert.deepEqual(calls.map(([kind, pluginId, input]) => [kind, pluginId, input.path ?? input.projectId]), [
    ["project", "demo.project-import", "/tmp/imported-project"],
    ["import", "demo.project-import", 7],
  ]);
});

test("project binding requires the project permission", async (t) => {
  const calls = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    project: {
      create: async () => calls.push("project"),
    },
    session: {
      import: async () => calls.push("import"),
    },
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  const dir = writePlugin({
    id: "demo.project-permission",
    permissions: ["session.import"],
    main: `
      module.exports = {
        async onLoad() {
          await pi.commands.register({
            id: "denied",
            title: "Denied",
            run: async () => {
              try { await pi.project.create({ path: "/tmp/project" }); }
              catch (error) { await pi.ui.showToast("create:" + error.code); }
              try {
                await pi.session.import({
                  source: "legacy",
                  externalId: "bound-1",
                  title: "Bound",
                  projectId: 7,
                  createdAt: "2026-01-01T00:00:00Z",
                  updatedAt: "2026-01-01T00:00:01Z",
                  messages: [{ role: "user", content: "hello", createdAt: "2026-01-01T00:00:00Z" }]
                });
              } catch (error) { await pi.ui.showToast("import:" + error.code); }
            }
          });
        }
      };
    `,
  });
  await runtime.loadFromPath(dir, ["session.import"]);
  await runCommand(runtime, "denied");
  assert.deepEqual(calls, []);
  assert.deepEqual(runtime.drainToasts(), [
    "create:PERMISSION_DENIED",
    "import:PERMISSION_DENIED",
  ]);
});

test("plugin session read, update, and delete permissions are independent", async (t) => {
  const calls = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    session: {
      list: async () => calls.push("list"),
      rename: async () => calls.push("rename"),
      delete: async () => calls.push("delete"),
    },
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  const dir = writePlugin({
    id: "demo.session-permissions",
    permissions: ["session.import"],
    main: `
      module.exports = {
        async onLoad() {
          await pi.commands.register({
            id: "permissions",
            title: "Permissions",
            run: async () => {
              for (const [name, call] of [
                ["read", () => pi.session.list()],
                ["update", () => pi.session.rename({ sessionId: "s1", title: "Renamed" })],
                ["delete", () => pi.session.delete({ sessionId: "s1" })]
              ]) {
                try { await call(); }
                catch (error) { await pi.ui.showToast(name + ":" + error.code); }
              }
            }
          });
        }
      };
    `,
  });
  await runtime.loadFromPath(dir, ["session.import"]);
  await runCommand(runtime, "permissions");
  assert.deepEqual(calls, []);
  assert.deepEqual(runtime.drainToasts(), [
    "read:PERMISSION_DENIED",
    "update:PERMISSION_DENIED",
    "delete:PERMISSION_DENIED",
  ]);
});

test("plugin usage listTurns requires usage.read and forwards the plugin id", async (t) => {
  const calls = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    usage: {
      listTurns: async (pluginId, input) => {
        calls.push(["listTurns", pluginId, input]);
        return { turns: [{ turnId: "t2", inputTokens: 100 }], nextCursor: null };
      },
    },
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  const dir = writePlugin({
    id: "demo.usage",
    permissions: ["usage.read"],
    main: `
      module.exports = {
        async onLoad() {
          await pi.commands.register({
            id: "read-usage",
            title: "Read usage",
            run: async () => {
              const page = await pi.usage.listTurns({ fromMs: 1, toMs: 2, limit: 7 });
              await pi.ui.showToast("rows:" + page.turns.length);
              await pi.usage.listTurns({ limit: 5, projectId: 3, sessionId: "s2", cursor: "abc" });
              for (const [name, call] of [
                ["badWindow", () => pi.usage.listTurns({ fromMs: 0, toMs: 1 + 365 * 86400000 })],
                ["badOrder", () => pi.usage.listTurns({ fromMs: 10, toMs: 1 })],
                ["badFromOnly", () => pi.usage.listTurns({ fromMs: 0 })],
                ["badLimit", () => pi.usage.listTurns({ limit: 0 })],
                ["badProject", () => pi.usage.listTurns({ projectId: "seven" })],
                ["badFrom", () => pi.usage.listTurns({ fromMs: -1 })]
              ]) {
                try { await call(); }
                catch (error) { await pi.ui.showToast(name + ":" + error.code); }
              }
            }
          });
        }
      };
    `,
  });
  await runtime.loadFromPath(dir, ["usage.read"]);
  await runCommand(runtime, "read-usage");
  // Authorized calls forward with the plugin id and only the normalized fields.
  assert.deepEqual(calls, [
    ["listTurns", "demo.usage", { fromMs: 1, toMs: 2, limit: 7 }],
    ["listTurns", "demo.usage", { limit: 5, projectId: 3, sessionId: "s2", cursor: "abc" }],
  ]);
  assert.deepEqual(runtime.drainToasts(), [
    "rows:1",
    "badWindow:INVALID_PARAMS",
    "badOrder:INVALID_PARAMS",
    "badFromOnly:INVALID_PARAMS",
    "badLimit:INVALID_PARAMS",
    "badProject:INVALID_PARAMS",
    "badFrom:INVALID_PARAMS",
  ]);
});

test("plugin usage listTurns is refused without the usage.read permission", async (t) => {
  const calls = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    usage: {
      listTurns: async () => calls.push("listTurns"),
    },
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  const dir = writePlugin({
    id: "demo.usage-denied",
    permissions: ["session.read.own"],
    main: `
      module.exports = {
        async onLoad() {
          await pi.commands.register({
            id: "peek",
            title: "Peek",
            run: async () => {
              try { await pi.usage.listTurns(); }
              catch (error) { await pi.ui.showToast("listTurns:" + error.code); }
            }
          });
        }
      };
    `,
  });
  await runtime.loadFromPath(dir, ["session.read.own"]);
  await runCommand(runtime, "peek");
  assert.deepEqual(calls, []);
  assert.deepEqual(runtime.drainToasts(), ["listTurns:PERMISSION_DENIED"]);
});
