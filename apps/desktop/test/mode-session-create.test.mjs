import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { IPC } from "../../../packages/shared/src/protocol.ts";

// Execute the production registrar with only external services replaced.
const source = readFileSync(new URL("../electron/main/ipc/session-ipc.ts", import.meta.url), "utf8");
const module = { exports: {} };
const imports = {
  electron: { shell: {} }, "node:fs": {}, "node:path": {},
  "@pi-desktop/shared": { IPC }, "../importers": {},
  "../services/session-collaboration": {}, "../bootstrap/remote-hosts.js": {},
  "../services/session-search": {},
};
new Function("require", "exports", "module", ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText)((id) => {
  assert.ok(Object.hasOwn(imports, id), `unexpected dependency: ${id}`);
  return imports[id];
}, module.exports, module);

test("creating a Goal or custom session persists its selected snapshot before returning", async () => {
  for (const mode of ["goal", "review"]) {
    const handlers = new Map();
    const calls = [];
    const snapshot = { id: mode, stages: [{ id: "work" }] };
    const host = { async call(method, input) {
      calls.push([method, input]);
      return { session: { id: "s", mode } };
    } };
    module.exports.registerSessionIpc({
      registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
      getHost: () => host, getSidecar: () => null, logger: { app() {} },
      sessionCapabilityContext: async () => ({ providers: [], defaults: {} }),
      enrichSession: session => session,
      modeCatalog: { snapshotFor: async id => { assert.equal(id, mode); return snapshot; } },
    });
    await handlers.get(IPC.invoke.sessionCreate)({ mode });
    assert.deepEqual(calls, [
      ["session.create", { mode }],
      ["session.configure", { id: "s", mode, modeSnapshot: snapshot }],
    ]);
  }
});
