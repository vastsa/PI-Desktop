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
  let registryFailure = false;
  const host = {
    async call(method, params, timeoutMs) {
      assert.equal(method, "plugins.list");
      assert.equal(params, undefined);
      assert.equal(timeoutMs, 5_000);
      if (registryFailure) throw new Error("Host restarting");
      return { plugins: [record] };
    },
  };
  let activeHost = host;
  const bridge = {
    plugins: { getLoaded: (id) => id === pluginId ? loaded : undefined },
    pluginViews: { isVisibleViewSender: (id, key) => id === 123 && key === "pi.file-manager/manager" },
    pluginSession,
    pluginActiveInProject: (id, projectPath) => id === pluginId && projectPath === workspace,
    getHost: () => activeHost,
    getWorkspacePath: () => workspace,
    publish: (delivery) => deliveries.push(delivery),
  };
  activeHost = null;
  await assert.rejects(addFileLinesFromView(pluginId, 123, payload, bridge), { code: "HOST_UNAVAILABLE" });
  activeHost = host;
  registryFailure = true;
  await assert.rejects(addFileLinesFromView(pluginId, 123, payload, bridge), /Host restarting/);
  registryFailure = false;
  assert.deepEqual(await addFileLinesFromView(pluginId, 123, payload, bridge), { ok: true });
  assert.deepEqual(deliveries, [{ sessionId: "selected", reference: payload }]);

  const normalizedPayload = { ...payload, workspace: `${workspace}/` };
  assert.deepEqual(await addFileLinesFromView(pluginId, 123, normalizedPayload, bridge), { ok: true });
  await assert.rejects(addFileLinesFromView(pluginId, 123, { ...payload, workspace: `${workspace}-other` }, bridge), /no longer active/);
  assert.deepEqual(deliveries.at(-1), { sessionId: "selected", reference: normalizedPayload });

  await assert.rejects(addFileLinesFromView(pluginId, 321, payload, bridge), /no longer active/);
  loaded.permissions.delete("fs.read");
  await assert.rejects(addFileLinesFromView(pluginId, 123, payload, bridge), /no longer active/);
  loaded.permissions.add("fs.read");
  record.enabled = false;
  await assert.rejects(addFileLinesFromView(pluginId, 123, payload, bridge), /not enabled in the Host registry/);
  record.enabled = true;
  record.version = "0.8.0";
  await assert.rejects(addFileLinesFromView(pluginId, 123, payload, bridge), /not enabled in the Host registry/);
  record.version = "0.9.0";

  const pending = addFileLinesFromView(pluginId, 123, payload, bridge);
  pluginSession.setActiveSession({ ...session, sessionId: "different" });
  await assert.rejects(pending, /no longer active/);
  assert.equal(deliveries.length, 2);
});
