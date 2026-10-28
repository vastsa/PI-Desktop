import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));

test("plugin workspace transport resolves an admitted identity and rejects changed bindings", { timeout: 60_000 }, async () => {
  const module = await import("../electron/main/remote/plugin-workspace-files.ts");
  assert.equal(typeof module.createPluginWorkspaceReader, "function", "Desktop must bind plugin reads to the durable remote project");
  const calls = []; let binding = { hostKey: "ssh", path: "/repo" };
  const owner = { call: async method => {
    assert.equal(method, "project.groups.list");
    return { groups: [{ primaryPath: "remote-project:one", remote: { ...binding } }] };
  } };
  let active = owner;
  const started = Promise.withResolvers(); const finish = Promise.withResolvers();
  const boot = { workspacePluginFiles: async (key, request) => { calls.push({ key, request }); started.resolve(); return finish.promise; } };
  const read = module.createPluginWorkspaceReader({ getHost: () => active, getBoot: () => boot });
  const input = { workspacePath: "remote-project:one", operation: "preview", ref: "docs/a.md", scope: ["docs/**"] };
  const pending = read(input);
  await started.promise;
  binding = { hostKey: "other", path: "/other" };
  finish.resolve({ kind: "text", content: "old remote", size: 10, mtimeMs: 1 });
  await assert.rejects(pending, error => error.code === "WORKSPACE_CHANGED");
  assert.deepEqual(calls, [{ key: "ssh", request: { path: "/repo", operation: "preview", ref: "docs/a.md", scope: ["docs/**"] } }]);
  await assert.rejects(read({ ...input, workspacePath: "remote-project:missing" }), { code: "NOT_FOUND" });
  active = null;
  await assert.rejects(read(input), { code: "HOST_UNAVAILABLE" });
});
