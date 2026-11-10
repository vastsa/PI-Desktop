import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire, register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import * as shared from "@pi-desktop/shared";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const roots = await import("../electron/main/workspace-roots.ts");
const require = createRequire(import.meta.url);
const sourceUrl = new URL("../electron/main/ipc/workspace-ipc.ts", import.meta.url);
const { outputText } = ts.transpileModule(readFileSync(sourceUrl, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  fileName: "workspace-ipc.ts",
});

// Execute the public handlers with real validation, filesystem checks and cache
// refresh. Native persistence and the remote directory service are external edges.
function fixture(dataDir) {
  const handlers = new Map();
  const writes = [];
  const browses = [];
  let storageError;
  const host = {
    isAvailable: () => true,
    async call(method, params) {
      if (method === "project.groups.list") return { groups: [] };
      if (storageError) throw storageError;
      writes.push({ method, params: structuredClone(params) });
      return { group: { id: "fixture-group", ...params } };
    },
  };
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText.replaceAll("import.meta.url", JSON.stringify(sourceUrl.href)))(
    (specifier) => {
      if (specifier.startsWith("node:")) return require(specifier);
      if (specifier === "@pi-desktop/shared") return shared;
      if (specifier === "../workspace-roots") return roots;
      if (specifier === "../bootstrap/remote-hosts") return {
        getActiveRemoteHostsBoot: () => ({ browseProjects: async (hostKey, path) => {
          browses.push({ hostKey, path });
          return { path: "/srv/canonical" };
        } }),
      };
      // Sidebar preferences register alongside the workspace handlers; this test
      // exercises project save only.
      if (specifier === "./sidebar-preferences-ipc") return { registerSidebarPreferencesIpc() {} };
      // These imports belong to unrelated handlers; accessing one is a failure.
      return new Proxy({}, { get: (_target, key) => {
        throw new Error(`Unexpected dependency in project save: ${specifier}.${String(key)}`);
      } });
    }, module.exports, module,
  );
  module.exports.registerWorkspaceIpc({
    registrar: { handle: (name, callback) => handlers.set(name, callback),
      handleWithEvent: (name, callback) => handlers.set(name, callback) },
    getHost: () => host, getSidecar: () => null, dataDir,
  });
  return { writes, browses, invoke: (name, input) => handlers.get(name)(input),
    failStorage: () => { storageError = new Error("storage unavailable"); } };
}

const routes = [
  ["projectGroupCreate", "project.group.create", (root) => ({ name: "Project", folders: [root] })],
  ["projectGroupUpdate", "project.group.update", (root) => ({ groupId: "group", name: "Edited", folders: [root], primary: root })],
  ["projectGroupCreateRemote", "project.group.createRemote", () => ({ name: "Remote", hostKey: "fixture-host", path: "/srv/requested" })],
  ["projectGroupRename", "project.group.rename", () => ({ groupId: "group", name: "Renamed" })],
];

for (const [channel, method, input] of routes) {
  test(`${channel} preserves omitted settings and forwards explicit selection/reset atomically`, async (t) => {
    const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "project-settings-ipc-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const f = fixture(root);
    const save = (settings) => f.invoke(shared.IPC.invoke[channel], { ...input(root), ...settings });
    await save({});
    assert.equal(Object.hasOwn(f.writes[0].params, "capabilities"), false);
    assert.equal(Object.hasOwn(f.writes[0].params, "instructions"), false);
    const settings = { capabilities: { skillIds: [], mcpServerIds: ["missing", "missing", "Missing"] }, instructions: "# App-owned\n中文" };
    await save(settings);
    assert.equal(f.writes[1].method, method);
    assert.deepEqual(f.writes[1].params.capabilities, { skillIds: [], mcpServerIds: ["missing", "Missing"] });
    assert.equal(f.writes[1].params.instructions, settings.instructions);
    if (channel === "projectGroupCreateRemote") {
      assert.deepEqual(f.writes[1].params.remote, { hostKey: "fixture-host", path: "/srv/canonical" });
      assert.deepEqual(f.browses[1], { hostKey: "fixture-host", path: "/srv/requested" });
    }
    await save({ capabilities: {}, instructions: "" });
    assert.deepEqual(f.writes[2].params.capabilities, {});
    assert.equal(f.writes[2].params.instructions, "");
    const browseCount = f.browses.length;
    for (const invalid of [{ capabilities: null }, { capabilities: { skillIds: null } }, { instructions: "中".repeat(11_000) }]) {
      await assert.rejects(save(invalid));
    }
    assert.equal(f.writes.length, 3, "invalid settings must not partially save a project");
    assert.equal(f.browses.length, browseCount, "invalid settings must not contact the remote host");
    f.failStorage();
    await assert.rejects(save(settings), /storage unavailable/);
  });
}
