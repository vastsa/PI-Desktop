import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { remoteWorkspaceForFiles } = await import("../electron/main/remote/workspace-file-scope.ts");
const remote = { hostKey: "ssh", path: "/home/app" };
function hostFor(sessions, selected = "/local/app", groups = [{ primaryPath: "remote-project:group", remote }]) {
  const calls = [];
  return { calls, async call(method, params) {
    calls.push({ method, params });
    if (method === "session.get") return { session: sessions[params.id] };
    if (method === "workspace.get") return { workspace: { path: selected } };
    if (method === "project.groups.list") return { groups };
    assert.fail("Unexpected persistence request: " + method);
  } };
}
test("a retained remote file view follows its own group while a local project is selected", async () => {
  const host = hostFor({ remote: { projectPath: "remote-project:group" }, local: { projectPath: "/local/app" } });
  assert.deepEqual(await remoteWorkspaceForFiles(() => host, "remote"), remote);
  assert.equal(await remoteWorkspaceForFiles(() => host, "local"), null);
  assert.equal(host.calls.some(call => call.method === "workspace.get"), false);
});
test("a home file view resolves the currently selected remote group without a remote session", async () => {
  const host = hostFor({}, "remote-project:group");
  assert.deepEqual(await remoteWorkspaceForFiles(() => host), remote);
  assert.equal(host.calls.some(call => call.method.startsWith("session.")), false);
});
test("missing session or remote binding fails closed instead of reading current local files", async () => {
  const host = hostFor({ remote: { projectPath: "remote-project:missing" } });
  await assert.rejects(remoteWorkspaceForFiles(() => host, "missing"), { errorCode: "NOT_FOUND" });
  await assert.rejects(remoteWorkspaceForFiles(() => host, "remote"), { errorCode: "NOT_FOUND" });
});
test("a replaced local Host cannot supply a late remote file binding", async () => {
  let finish;
  const owner = { call: () => new Promise(resolve => { finish = resolve; }) };
  let active = owner;
  const pending = remoteWorkspaceForFiles(() => active, "session");
  active = hostFor({});
  finish({ session: { projectPath: "remote-project:group" } });
  await assert.rejects(pending, { errorCode: "HOST_UNAVAILABLE" });
});
