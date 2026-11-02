import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

register(new URL("./ts-import-hooks.mjs", import.meta.url));
const { PluginRuntime } = await import("../../electron/main/plugin-runtime.ts");

export function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => child.connected && child.send(message),
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

export async function loadProjectPicker(t, services = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-plugin-projects-"));
  const runtime = new PluginRuntime({
    hostEntry: fileURLToPath(new URL("../../electron/main/plugin-host-process.mjs", import.meta.url)),
    spawnProcess: forkPluginProcess,
    getWorkspacePath: () => null,
    ...services,
  });
  t.after(async () => {
    for (const plugin of runtime.listLoaded()) await runtime.unload(plugin.manifest.id);
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    schemaVersion: 1, id: "demo.projects", name: "Project picker", version: "0.0.1",
    main: "main.js", permissions: [],
  }));
  writeFileSync(join(dir, "main.js"), `module.exports = {
    async onLoad() {
      await pi.commands.register({ id: "pick-project", title: "Pick project", run: async () => {
        const projects = await pi.projects.list();
        const workspace = await pi.workspace.get();
        await pi.ui.showToast(JSON.stringify({ projects, workspace }));
      }});
    }
  };`);
  await runtime.loadFromPath(dir, []);
  return runtime;
}
