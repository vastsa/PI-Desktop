import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import ts from "typescript";
import { IPC } from "../../../packages/shared/src/protocol.ts";
import { localNativeProjectPaths } from "../electron/main/services/session-search.ts";

const source = fs.readFileSync(new URL("../electron/main/ipc/session-ipc.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
});
const imports = {
  electron: { shell: {} },
  "node:fs": fs,
  "node:path": path,
  "@pi-desktop/shared": { IPC },
  "../importers": {},
  "../services/session-collaboration": {},
  "../services/session-search": { localNativeProjectPaths },
  "../bootstrap/remote-hosts.js": { getActiveRemoteHostsBoot: () => null },
};
const loaded = { exports: {} };
new Function("require", "exports", "module", outputText)((id) => {
  assert.ok(Object.hasOwn(imports, id), `unexpected dependency: ${id}`);
  return imports[id];
}, loaded.exports, loaded);

// #1912: durable history alone cannot tell a new renderer which turns are live.
test("session listing returns the current host-owned running IDs after its reads settle", async () => {
  const handlers = new Map();
  const activeTurns = new Map([["completed-during-read", "turn-old"]]);
  let finishListing;
  const host = { call: async (method) => {
    if (method === "projects.list") return { projects: [] };
    assert.equal(method, "session.list");
    return new Promise((resolve) => { finishListing = resolve; });
  } };
  loaded.exports.registerSessionIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => null,
    activeTurns,
    sessionCapabilityContext: async () => ({ providers: [], defaults: {} }),
    enrichSession: (session) => session,
  });
  const pending = handlers.get(IPC.invoke.sessionList)();
  activeTurns.delete("completed-during-read");
  activeTurns.set("still-running", "turn-current");
  finishListing({ sessions: [{ id: "still-running", updatedAt: "2026-10-27T00:00:00Z" }] });
  const result = await pending;
  assert.deepEqual(result.runningSessionIds, ["still-running"]);
  activeTurns.clear();
  assert.deepEqual(result.runningSessionIds, ["still-running"], "the result must be a detached snapshot");
});
