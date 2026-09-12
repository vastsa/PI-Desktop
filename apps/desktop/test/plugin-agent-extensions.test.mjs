import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
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

function createRuntime(t) {
  const audits = [];
  let changed = 0;
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    audit: (entry) => audits.push(entry),
  });
  runtime.setServices({ agentExtensionsChanged: () => (changed += 1) });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  return { runtime, audits, changed: () => changed };
}

function writePlugin({ id, permissions, agentExtensions, files = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "pi-ax-plugin-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: `Plugin ${id}`,
      version: "0.1.0",
      main: "main.js",
      permissions,
      contributes: { agentExtensions },
    }),
  );
  writeFileSync(join(dir, "main.js"), "module.exports = {};\n");
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

test("contributes.agentExtensions is indexed with the plugin's identity when agent.extension is granted", async (t) => {
  const { runtime, changed } = createRuntime(t);
  const dir = writePlugin({
    id: "demo.ext",
    permissions: ["agent.extension"],
    agentExtensions: ["src/a.ts", "src/b.js"],
    files: { "src/a.ts": "export default function () {}\n", "src/b.js": "module.exports = () => {};\n" },
  });
  await runtime.loadFromPath(dir);
  const specs = runtime.getAgentExtensions();
  assert.deepEqual(
    specs.map((s) => [s.pluginId, s.pluginName, s.entry]),
    [
      ["demo.ext", "Plugin demo.ext", join(dir, "src/a.ts")],
      ["demo.ext", "Plugin demo.ext", join(dir, "src/b.js")],
    ],
  );
  assert.equal(specs[0].id, realpathSync(join(dir, "src/a.ts")), "id is the realpath");
  assert.equal(specs[0].root, dir);
  assert.equal(changed(), 1);

  await runtime.unload("demo.ext");
  assert.deepEqual(runtime.getAgentExtensions(), []);
  assert.equal(changed(), 2, "unload announces the change once");
});

test("without agent.extension the modules are skipped and audited, and missing files are skipped", async (t) => {
  const { runtime, audits } = createRuntime(t);
  const dir = writePlugin({
    id: "demo.nogrant",
    permissions: ["agent.extension"],
    agentExtensions: ["src/a.ts"],
    files: { "src/a.ts": "export default function () {}\n" },
  });
  // The manifest declares the permission; the recorded grant list omits it.
  await runtime.loadFromPath(dir, []);
  assert.deepEqual(runtime.getAgentExtensions(), []);
  assert.ok(
    audits.some((a) => a.api === "plugin.agentExtensions.skipped" && a.errorCode === "PERMISSION_DENIED"),
  );

  const dir2 = writePlugin({
    id: "demo.missing",
    permissions: ["agent.extension"],
    agentExtensions: ["src/a.ts", "src/gone.ts"],
    files: { "src/a.ts": "export default function () {}\n" },
  });
  await runtime.loadFromPath(dir2);
  assert.deepEqual(runtime.getAgentExtensions().map((s) => s.entry), [join(dir2, "src/a.ts")]);
  assert.ok(audits.some((a) => a.api === "plugin.agentExtensions.skipped" && a.errorCode === "NOT_FOUND"));
});
