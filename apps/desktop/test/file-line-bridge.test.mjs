import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addFileLinesFromView } from "../electron/main/file-line-reference.ts";
import { createPluginSessionContext } from "../electron/main/services/plugin-session-context.ts";

const pluginId = "pi.file-manager";

test("an installed File Manager can add lines only to the session that authorized the request", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-file-line-bridge-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const path = join(workspace, "sample.txt");
  await writeFile(path, "first\nsecond\n");
  const payload = { workspace, path, start: 2, end: 2 };
  const loaded = {
    development: false,
    disposing: false,
    permissions: new Set(["fs.read", "ui.view"]),
    manifest: { version: "0.9.0" },
  };
  const pluginSession = createPluginSessionContext({ getActiveTurn: () => null, announce() {} });
  const session = { sessionId: "selected", projectPath: workspace };
  pluginSession.setActiveSession(session);
  const deliveries = [];
  const record = { id: pluginId, version: "0.9.0", enabled: true, source: "marketplace" };
  const host = {
    async call(method) {
      assert.equal(method, "plugins.list");
      return { plugins: [record] };
    },
  };
  const bridge = {
    plugins: { getLoaded: (id) => id === pluginId ? loaded : undefined },
    pluginViews: { isVisibleViewSender: (id, key) => id === 123 && key === "pi.file-manager/manager" },
    pluginSession,
    pluginActiveInProject: (id, projectPath) => id === pluginId && projectPath === workspace,
    getHost: () => host,
    getWorkspacePath: () => workspace,
    publish: (delivery) => deliveries.push(delivery),
  };
  assert.deepEqual(await addFileLinesFromView(pluginId, 123, payload, bridge), { ok: true });
  assert.deepEqual(deliveries, [{ sessionId: "selected", reference: payload }]);

  await assert.rejects(addFileLinesFromView(pluginId, 321, payload, bridge), /outside the active project or session/);
  loaded.permissions.delete("fs.read");
  await assert.rejects(addFileLinesFromView(pluginId, 123, payload, bridge), /outside the active project or session/);
  loaded.permissions.add("fs.read");
  record.enabled = false;
  await assert.rejects(addFileLinesFromView(pluginId, 123, payload, bridge), /no longer active/);
  record.enabled = true;

  const pending = addFileLinesFromView(pluginId, 123, payload, bridge);
  pluginSession.setActiveSession({ ...session, sessionId: "different" });
  await assert.rejects(pending, /no longer active/);
  assert.equal(deliveries.length, 1);
});
