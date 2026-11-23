import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import * as devkit from "@pi-desktop/plugin-devkit";

const require = createRequire(import.meta.url);
const compile = (source) => ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
}).outputText;

function loadModule(url, dependencies = {}) {
  const module = { exports: {} };
  new Function("require", "exports", "module", compile(readFileSync(url, "utf8")))(
    (id) => dependencies[id] ?? require(id), module.exports, module,
  );
  return module.exports;
}

const { resolveWithinRoot } = loadModule(
  new URL("../../../packages/host-runtime/src/workspace-files.ts", import.meta.url),
);
const { registerPluginDevTools } = loadModule(
  new URL("../electron/main/plugin-dev-tools.ts", import.meta.url),
  { "@pi-desktop/plugin-devkit": devkit, "@pi-desktop/host-runtime": { resolveWithinRoot } },
);

// Execute the production root resolver and its real DI wiring, not a copy of
// their behavior. Only Host RPC and the Electron plugin loader are external edges.
const source = readFileSync(new URL("../electron/main/runtime/sidecar.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("sidecar.ts", source, ts.ScriptTarget.Latest, true);
let rootDeclaration;
let registration;
function visit(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "sessionFileRoot") {
    rootDeclaration = node.getText(tree);
  }
  if (ts.isCallExpression(node) && node.expression.getText(tree) === "registerPluginDevTools") {
    registration = node.getText(tree);
  }
  ts.forEachChild(node, visit);
}
visit(tree);
assert.ok(rootDeclaration && registration, "production plugin workspace wiring must exist");

function toolsFor(host) {
  const tools = new Map();
  const loaded = [];
  new Function("runtimeState", "s", "registerPluginDevTools", "plugins", "sendToRenderer", "IPC",
    compile(`const ${rootDeclaration}; ${registration};`),
  )(
    { host }, { setLocalTool: (name, handler) => tools.set(name, handler) }, registerPluginDevTools,
    {
      loadFromPath: async (path) => { loaded.push(path); return { id: "test.plugin" }; },
      watchDevPlugin: () => {}, drainToasts: () => [],
    }, () => {}, { event: { pluginChanged: "pluginChanged" } },
  );
  return { tools, loaded };
}

function hostFor(sessions, scratchRoot) {
  const calls = [];
  return {
    calls,
    async call(method, input) {
      calls.push({ method, input });
      if (method === "session.get") return { session: sessions[input.id] ?? null };
      if (method === "session.getScratchPath") return { path: join(scratchRoot, input.sessionId) };
      if (method === "worktree.location") return { path: sessions[input.sessionId].worktreePath };
      if (method === "plugins.loadDev") return { plugin: { permissions: [] } };
      throw new Error(`Unexpected RPC: ${method}`);
    },
  };
}

const invoke = (tools, name, sessionId, directory = "word-to-pdf") => tools.get(name)({
  sessionId, args: { directory, template: "panel-basic" },
});

test("temporary session scaffolds, checks and packs in its own host-owned scratch directory", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "plugin-workspace-"));
  try {
    const host = hostFor({ temporary: {} }, scratch);
    const { tools, loaded } = toolsFor(host);
    const created = await invoke(tools, "PluginScaffold", "temporary");
    assert.equal(created.ok, true, created.content);
    const target = join(scratch, "temporary", "word-to-pdf");
    assert.ok(JSON.parse(await readFile(join(target, "manifest.json"), "utf8")).id);
    assert.deepEqual(loaded, [target]);
    assert.equal((await invoke(tools, "PluginCheck", "temporary")).ok, true);
    assert.equal((await invoke(tools, "PluginPack", "temporary")).ok, true);
    assert.ok(host.calls.some(({ method, input }) =>
      method === "session.getScratchPath" && input.sessionId === "temporary"));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

for (const kind of ["project", "worktree"]) {
  test(`${kind} sessions retain their authoritative root without requesting scratch`, async () => {
    const root = await mkdtemp(join(tmpdir(), "plugin-project-"));
    try {
      const session = kind === "worktree"
        ? { projectPath: join(root, "project"), worktree: {}, worktreePath: join(root, "worktree") }
        : { projectPath: ` ${root} ` };
      const host = hostFor({ bound: session }, join(root, "scratch"));
      const { tools, loaded } = toolsFor(host);
      const result = await invoke(tools, "PluginScaffold", "bound");
      assert.equal(result.ok, true, result.content);
      assert.deepEqual(loaded, [join(kind === "worktree" ? session.worktreePath : root, "word-to-pdf")]);
      assert.ok(!host.calls.some(({ method }) => method === "session.getScratchPath"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const name of ["PluginScaffold", "PluginCheck", "PluginPack"]) {
  test(`${name} rejects traversal outside the calling session scratch root`, async () => {
    const host = hostFor({ first: {}, second: {} }, tmpdir());
    const { tools, loaded } = toolsFor(host);
    const result = await invoke(tools, name, "first", "../second/plugin");
    assert.equal(result.ok, false);
    assert.match(result.content, /outside the workspace/);
    assert.deepEqual(loaded, []);
    assert.ok(!host.calls.some(({ method }) => method === "plugins.loadDev"));
  });
}

test("different temporary sessions resolve independently rather than using a visible project", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "plugin-isolation-"));
  try {
    const host = hostFor({ first: {}, second: { projectPath: "   " } }, scratch);
    const { tools, loaded } = toolsFor(host);
    for (const id of ["first", "second"]) {
      const result = await invoke(tools, "PluginScaffold", id);
      assert.equal(result.ok, true, result.content);
    }
    assert.deepEqual(loaded, ["first", "second"].map((id) => resolve(scratch, id, "word-to-pdf")));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

for (const host of [null, hostFor({}, tmpdir())]) {
  test(`missing ${host ? "session" : "host"} fails closed without allocating scratch`, async () => {
    const { tools } = toolsFor(host);
    const result = await invoke(tools, "PluginScaffold", "missing");
    assert.equal(result.ok, false);
    assert.match(result.content, /no workspace is open/);
    assert.ok(!host?.calls.some(({ method }) => method === "session.getScratchPath"));
  });
}

test("an unresolved isolated worktree does not fall back to a project or scratch", async () => {
  const host = hostFor({ isolated: { worktree: {}, projectPath: "/must-not-use" } }, tmpdir());
  const { tools } = toolsFor(host);
  const result = await invoke(tools, "PluginScaffold", "isolated");
  assert.equal(result.ok, false);
  assert.ok(!host.calls.some(({ method }) => method === "session.getScratchPath"));
});

for (const method of ["session.get", "session.getScratchPath", "worktree.location"]) {
  test(`${method} errors remain observable instead of becoming no-workspace errors`, async () => {
    const host = hostFor({ temporary: method === "worktree.location" ? { worktree: {} } : {} }, tmpdir());
    const call = host.call.bind(host);
    host.call = async (name, input) => {
      if (name === method) throw new Error(`RPC failed: ${method}`);
      return call(name, input);
    };
    const { tools } = toolsFor(host);
    await assert.rejects(invoke(tools, "PluginScaffold", "temporary"), { message: `RPC failed: ${method}` });
  });
}
