import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const hostEntry = join(dirname(fileURLToPath(import.meta.url)), "../electron/main/plugin-host-process.mjs");

function createRuntime(t) {
  const folders = [];
  const runtime = new PluginRuntime({
    hostEntry,
    spawnProcess: ({ entry }) => {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      return {
        postMessage: (message) => child.send(message),
        onMessage: (handler) => child.on("message", handler),
        onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
        kill: () => child.kill(),
      };
    },
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
    for (const folder of folders) rmSync(folder, { recursive: true, force: true });
  });
  const load = async (id, commandId) => {
    const folder = mkdtempSync(join(tmpdir(), "pi-command-owner-"));
    folders.push(folder);
    writeFileSync(join(folder, "manifest.json"), JSON.stringify({
      schemaVersion: 1, id, name: id, version: "0.0.1", main: "main.js", permissions: [],
    }));
    writeFileSync(join(folder, "main.js"), `
      const initialId = ${JSON.stringify(commandId ?? null)};
      const registerCommand = (id, marker) => pi.commands.register({
        id, title: marker, run: () => pi.ui.showToast(marker),
      });
      module.exports = {
        async onLoad() {
          if (initialId) await registerCommand(initialId, ${JSON.stringify(id)});
        },
        async onPanelInvoke(channel, input) {
          if (channel === "command.register") return registerCommand(input.id, input.marker);
          if (channel === "command.unregister") return pi.commands.unregister(input.id);
          throw new Error("unknown test operation: " + channel);
        },
      };
    `);
    await runtime.loadFromPath(folder);
  };
  return { runtime, load };
}

async function runCommand(runtime, id, marker) {
  const command = runtime.getCommands().find((candidate) => candidate.id === id);
  assert.ok(command, `missing command: ${id}`);
  await command.run();
  assert.deepEqual(runtime.drainToasts(), [marker]);
}

test("another plugin cannot replace a registered command", { timeout: 60_000 }, async (t) => {
  const { runtime, load } = createRuntime(t);
  await load("audit.owner", "shared-command");
  await load("audit.other");
  await assert.rejects(
    runtime.invokePanelBridge("audit.other", "command.register", { id: "shared-command", marker: "replacement" }),
    { code: "CONFLICT" },
  );
  assert.equal(runtime.getCommands()[0].pluginId, "audit.owner");
  await runCommand(runtime, "shared-command", "audit.owner");
  await runtime.invokePanelBridge("audit.other", "command.register", { id: "other-command", marker: "other" });
  await runCommand(runtime, "other-command", "other");
});

test("another plugin cannot unregister a registered command", { timeout: 60_000 }, async (t) => {
  const { runtime, load } = createRuntime(t);
  await load("audit.owner", "shared-command");
  await load("audit.other");
  await assert.rejects(
    runtime.invokePanelBridge("audit.other", "command.unregister", { id: "shared-command" }),
    { code: "PERMISSION_DENIED" },
  );
  await runCommand(runtime, "shared-command", "audit.owner");
});

test("the owner can update its command without changing a legacy ID", { timeout: 60_000 }, async (t) => {
  const { runtime, load } = createRuntime(t);
  await load("audit.owner", "legacy-command");
  await runtime.invokePanelBridge("audit.owner", "command.register", { id: "legacy-command", marker: "updated" });
  assert.equal(runtime.getCommands().length, 1);
  assert.equal(runtime.getCommands()[0].id, "legacy-command");
  await runCommand(runtime, "legacy-command", "updated");
});

test("owner removal is idempotent and releases the ID for another plugin", { timeout: 60_000 }, async (t) => {
  const { runtime, load } = createRuntime(t);
  await load("audit.owner", "shared-command");
  await load("audit.other");
  await runtime.invokePanelBridge("audit.owner", "command.unregister", { id: "shared-command" });
  await runtime.invokePanelBridge("audit.owner", "command.unregister", { id: "shared-command" });
  assert.deepEqual(runtime.getCommands(), []);
  await runtime.invokePanelBridge("audit.other", "command.register", { id: "shared-command", marker: "new owner" });
  await runCommand(runtime, "shared-command", "new owner");
});

test("a conflicting command during plugin load leaves the existing owner running", { timeout: 60_000 }, async (t) => {
  const { runtime, load } = createRuntime(t);
  await load("audit.owner", "shared-command");
  await assert.rejects(load("audit.other", "shared-command"), { code: "CONFLICT" });
  assert.deepEqual(runtime.listLoaded().map((loaded) => loaded.manifest.id), ["audit.owner"]);
  await runCommand(runtime, "shared-command", "audit.owner");
});

test("concurrent registrations admit only one owner", { timeout: 60_000 }, async (t) => {
  const { runtime, load } = createRuntime(t);
  await load("audit.first");
  await load("audit.second");
  const results = await Promise.allSettled(["audit.first", "audit.second"].map((pluginId) =>
    runtime.invokePanelBridge(pluginId, "command.register", { id: "shared-command", marker: pluginId }),
  ));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "CONFLICT");
  const command = runtime.getCommands()[0];
  await runCommand(runtime, "shared-command", command.pluginId);
  const loser = command.pluginId === "audit.first" ? "audit.second" : "audit.first";
  await runtime.unload(loser);
  await runCommand(runtime, "shared-command", command.pluginId);
});
