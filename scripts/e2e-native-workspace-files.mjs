import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const temporary = await mkdtemp(join(root, "apps/desktop/.native-file-e2e-"));
try {
  const project = join(temporary, "native-project");
  await mkdir(project);
  await writeFile(join(project, "note.md"), "NATIVE FILE CONTENT");
  await build({ entryPoints: [join(root, "apps/desktop/electron/main/ipc/workspace-ipc.ts")], outfile: join(temporary, "workspace.mjs"), bundle: true, platform: "node", format: "esm", packages: "external", nodePaths: [join(root, "apps/desktop/node_modules")] });
  await writeFile(join(temporary, "main.cjs"), `
const assert = require("node:assert/strict");
const { app } = require("electron");
const { join } = require("node:path");


app.setPath("userData", join(__dirname, "profile"));
app.whenReady().then(async () => {
  const { IPC } = await import("@pi-desktop/shared");
  const { registerWorkspaceIpc } = await import("./workspace.mjs");
  const handlers = new Map();
  const host = { async call(method) {
    assert.ok(!method.startsWith("session."), "native request reached Desktop session storage");
    if (method === "project.groups.list") return { groups: [] };
    assert.fail("Unexpected Host request: " + method);
  } };
  const sidecar = { async call(method, input) {
    assert.equal(method, "native.session.get");
    if (input.id === "native-pi:missing") return { session: null };
    assert.equal(input.id, "native-pi:fixture");
    return { session: { projectPath: join(__dirname, "native-project"), source: "pi-native" } };
  } };
  registerWorkspaceIpc({
    registrar: { handle: (name, fn) => handlers.set(name, fn), handleWithEvent: (name, fn) => handlers.set(name, fn), assertMainWindowSender() {} },
    getHost: () => host, getSidecar: () => sidecar, dataDir: join(__dirname, "data"),
    plugins: {}, browserHost: {}, currentWorkspacePath: () => "C:/unrelated-selected-project",
  });
  const sessionId = "native-pi:fixture";
  const listing = await handlers.get(IPC.invoke.fsList)({ sessionId });
  assert.ok(listing.entries.some(entry => entry.name === "note.md"));
  const file = await handlers.get(IPC.invoke.fsRead)({ sessionId, path: "note.md" });
  assert.equal(file.content, "NATIVE FILE CONTENT");
  const resolved = await handlers.get(IPC.invoke.fsResolveRef)({ sessionId, ref: "note.md" });
  assert.equal(resolved.match.absolutePath, join(__dirname, "native-project", "note.md"));
  await assert.rejects(handlers.get(IPC.invoke.fsRead)({ sessionId: "native-pi:missing", path: "note.md" }), { errorCode: "NOT_FOUND" });
  console.log("NATIVE_WORKSPACE_FILES_E2E_OK");
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
`);
  const binary = resolveElectronBinary(root).electronBinary;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(binary, [join(temporary, "main.cjs")], { windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.on("data", chunk => { output += chunk; });
  const timer = setTimeout(() => child.kill(), 60_000);
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  clearTimeout(timer);
  assert.equal(code, 0, output);
  assert.match(output, /NATIVE_WORKSPACE_FILES_E2E_OK/);
  console.log("Native workspace file IPC E2E passed");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
