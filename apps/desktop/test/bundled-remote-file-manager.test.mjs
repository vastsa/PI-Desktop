import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

test("the actual bundled File Manager lists and reads remote files through the Host", { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "pi-bundled-remote-"));
  const root = join(directory, "remote");
  const data = join(directory, "data");
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(data);
  await writeFile(join(root, "docs/guide.md"), "ACTUAL BUNDLED REMOTE BYTES\n");
  await writeFile(join(root, ".env"), "private fixture");
  const previousData = process.env.PI_DESKTOP_DATA_DIR;
  process.env.PI_DESKTOP_DATA_DIR = data;
  const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
  const { createWorkspacePluginFiles } = await import("../../pi-host/src/plugin-workspace-files.ts");
  const identity = "remote-project:bundled-regression";
  const service = createWorkspacePluginFiles({ browseRoot: directory, protectedPaths: [data] });
  const requests = [];
  const runtime = new PluginRuntime({
    hostEntry: fileURLToPath(new URL("../electron/main/plugin-host-process.mjs", import.meta.url)),
    spawnProcess({ entry }) {
      const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
      return {
        postMessage: message => { if (child.connected) child.send(message); },
        onMessage: handler => child.on("message", handler),
        onExit: handler => child.on("exit", code => handler(code ?? 0)),
        kill: () => child.kill(),
      };
    },
    getWorkspacePath: () => identity,
    getWorkspaceInfo: () => ({
      path: identity, name: "Remote fixture", projectId: "bundled-regression",
      roots: [{ path: identity, name: "Remote fixture", primary: true }],
      remote: { hostKey: "fixture", path: root, readOnly: true },
    }),
    readRemoteWorkspaceFiles: async request => {
      requests.push(request);
      assert.equal(request.workspacePath, identity);
      assert.deepEqual(request.scope, ["**"]);
      return service.read({ path: root, operation: request.operation, ref: request.ref, scope: request.scope });
    },
  });
  t.after(async () => {
    try {
      await runtime.unload("pi.file-manager");
    } finally {
      await rm(directory, { recursive: true, force: true });
      if (previousData === undefined) delete process.env.PI_DESKTOP_DATA_DIR;
      else process.env.PI_DESKTOP_DATA_DIR = previousData;
    }
  });
  await runtime.loadFromPath(fileURLToPath(new URL("../resources/plugins/pi.file-manager", import.meta.url)));
  const invoke = (channel, payload) => runtime.invokePanelBridge("pi.file-manager", channel, payload);
  const listing = await invoke("fm.list", { path: "" });
  assert.equal(listing.ok, true, JSON.stringify(listing));
  assert.deepEqual(listing.entries.map(entry => entry.path), ["docs"]);
  const preview = await invoke("fm.read", { path: "docs/guide.md" });
  assert.equal(preview.ok, true, JSON.stringify(preview));
  assert.equal(preview.text, "ACTUAL BUNDLED REMOTE BYTES\n");
  assert.equal(preview.readOnly, true);
  const denied = await invoke("fm.write", { path: "docs/guide.md", text: "must not write" });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "REMOTE_READ_ONLY");
  assert.equal(await readFile(join(root, "docs/guide.md"), "utf8"), "ACTUAL BUNDLED REMOTE BYTES\n");
  assert.deepEqual(requests.map(request => request.operation), ["list", "preview"]);
});
