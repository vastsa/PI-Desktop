import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileManagerComposerDrag } from "../electron/main/file-manager-composer-drag.ts";
import { resolveComposerFileReference } from "../electron/main/composer-file-references.ts";
import { createPluginSessionContext } from "../electron/main/services/plugin-session-context.ts";
import { rememberProjectGroups } from "../electron/main/workspace-roots.ts";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "file-manager-composer-drag-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "project");
  await mkdir(workspace);
  const path = join(workspace, "project image.png");
  await writeFile(path, "fixture");
  const outside = join(root, "outside.txt");
  await writeFile(outside, "outside");

  const active = { sessionId: "selected", projectPath: workspace };
  const selection = createPluginSessionContext({ getActiveTurn: () => null, announce() {} });
  selection.setActiveSession(active);
  const loaded = {
    development: false,
    disposing: false,
    permissions: new Set(["fs.read", "ui.view"]),
    manifest: { version: "0.9.1" },
  };
  const record = { id: "pi.file-manager", version: "0.9.1", enabled: true };
  let afterRegistryRead = () => {};
  let session = { projectPath: workspace };
  const host = {
    async call(method, params) {
      if (method === "session.get") {
        assert.deepEqual(params, { id: active.sessionId, messageLimit: 1, contentLimit: 1 });
        return { session };
      }
      assert.equal(method, "plugins.list");
      afterRegistryRead();
      return { plugins: [record] };
    },
  };
  let now = 0;
  const drag = createFileManagerComposerDrag({
    plugins: { getLoaded: () => loaded },
    pluginViews: { isVisibleViewSender: (id, key) => id === 123 && key === "pi.file-manager/manager" },
    pluginSession: selection,
    pluginActiveInProject: () => true,
    getHost: () => host,
    getWorkspacePath: () => workspace,
  }, root, () => now);
  return {
    root, workspace, path, outside, active, selection, loaded, record, drag,
    begin: (candidate = path) => drag.begin(123, { workspace, path: candidate }),
    drop: (token, sessionId = active.sessionId) => drag.drop({ token, sessionId }),
    setAfterRegistryRead: (action) => { afterRegistryRead = action; },
    setHostSession: (next) => { session = next; },
    expire: () => { now += 61_000; },
  };
}

test("the trusted File Manager drop yields a single reusable metadata-only file reference", async (t) => {
  const { root, workspace, path, drag, begin, drop } = await fixture(t);
  assert.equal(drag.begin(42, { workspace, path }), null);
  assert.equal(drag.begin(123, { workspace: "/different/project", path }), null);
  const token = begin();
  assert.match(token, /^[0-9a-f-]{36}$/);
  assert.equal(await drop("unknown"), null);
  const reference = await drop(token);
  assert.equal(reference.path, path);
  assert.equal(reference.name, "project image.png");
  assert.equal(reference.size, 7);
  assert.equal(reference.kind, "file");
  assert.equal(await drop(token), null);
  assert.deepEqual(await resolveComposerFileReference(root, workspace, path, reference.localReference), reference);
  assert.deepEqual((await readdir(root)).sort(), ["composer-file-references", "outside.txt", "project"]);
});

test("the Host-owned session blocks remote, isolated, missing and relocated chats", async (t) => {
  const f = await fixture(t);
  for (const session of [
    undefined,
    { projectPath: f.workspace, remoteWorkspace: { path: "/remote/project" } },
    { projectPath: f.workspace, worktree: { status: "active", branch: "isolated" } },
    { projectPath: join(f.root, "relocated") },
  ]) {
    f.setHostSession(session);
    assert.equal(await f.drop(f.begin()), null);
  }
  f.selection.setActiveSession({ ...f.active, sessionId: "remote:session" });
  assert.equal(f.begin(), null);
  assert.deepEqual((await readdir(f.root)).sort(), ["outside.txt", "project"]);
});

test("a regular file in a secondary project folder belongs to the same draft", async (t) => {
  const f = await fixture(t);
  const secondary = join(f.root, "secondary");
  const path = join(secondary, "source.txt");
  await mkdir(secondary);
  await writeFile(path, "secondary root");
  assert.equal(await f.drop(f.begin(path)), null);
  rememberProjectGroups([{
    id: "two-folders",
    name: "Two folders",
    primaryPath: f.workspace,
    roots: [
      { path: f.workspace, name: "Primary", position: 0 },
      { path: secondary, name: "Secondary", position: 1 },
    ],
  }]);
  t.after(() => rememberProjectGroups(null));
  const reference = await f.drop(f.begin(path));
  assert.equal(reference.path, path);
  assert.deepEqual(await resolveComposerFileReference(f.root, f.workspace, path, reference.localReference), reference);
});

test("expired, foreign, stale, disabled and escaping drags cannot create a reference", async (t) => {
  const f = await fixture(t);
  const stale = f.begin();
  f.expire();
  assert.equal(await f.drop(stale), null);
  assert.equal(await f.drop(f.begin(), "somewhere-else"), null);
  assert.equal(await f.drop(f.begin(f.outside)), null);
  assert.equal(await f.drop(f.begin(f.workspace)), null);
  assert.equal(await f.drop(f.begin(join(f.workspace, "deleted.txt"))), null);
  const link = join(f.workspace, "linked.txt");
  await symlink(f.outside, link);
  assert.equal(await f.drop(f.begin(link)), null);

  f.loaded.permissions.delete("fs.read");
  assert.equal(f.begin(), null);
  f.loaded.permissions.add("fs.read");
  f.record.enabled = false;
  await assert.rejects(f.drop(f.begin()), /not enabled in the Host registry/);
  f.record.enabled = true;
  f.setAfterRegistryRead(() => f.selection.setActiveSession({ ...f.active, sessionId: "changed" }));
  assert.equal(await f.drop(f.begin()), null);
  assert.deepEqual((await readdir(f.root)).sort(), ["outside.txt", "project"]);
});
