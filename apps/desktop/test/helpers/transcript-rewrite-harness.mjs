import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import * as shared from "../../../../packages/shared/dist/index.js";
import { PersistenceOutbox } from "../../electron/main/persistence-outbox.ts";

// Electron shell and unused importer/search services are external to these IPC
// operations. The handlers, rewrite fence, outbox and Host port remain real.
function load(relative, imports) {
  const file = new URL(relative, import.meta.url);
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: file.pathname,
  });
  const module = { exports: {} };
  new Function("require", "exports", "module", outputText)((id) => {
    assert.ok(Object.hasOwn(imports, id), `unexpected IPC dependency: ${id}`);
    return imports[id];
  }, module.exports, module);
  return module.exports;
}

const { createSessionCoordination } = load("../../electron/main/runtime/session-coordination.ts", {
  "@pi-desktop/shared": shared,
  "../notification-policy": load("../../electron/main/notification-policy.ts", {}),
});
const { registerSessionIpc } = load("../../electron/main/ipc/session-ipc.ts", {
  electron: { shell: {} },
  "node:fs": fs,
  "node:path": path,
  "@pi-desktop/shared": shared,
  "../importers": {},
  "../services/session-collaboration": {},
  "../bootstrap/remote-hosts.js": {},
  "../services/session-search": {},
});

export function transcriptRewriteHarness(host, dataDir) {
  const handlers = new Map();
  const activeTurns = new Map();
  const coordination = createSessionCoordination({ activeTurns, getMainWindow: () => null, getViewingSessionId: () => null });
  const persistenceOutbox = new PersistenceOutbox(dataDir, () => undefined);
  registerSessionIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => host,
    getSidecar: () => null,
    dataDir,
    activeTurns,
    sessionProjects: new Map(),
    persistenceOutbox,
    logger: { app() {} },
    plugins: { broadcastEvent() {} },
    acquireSessionOperation: coordination.acquireSessionOperation,
    beginTranscriptRewrite: coordination.beginTranscriptRewrite,
  });
  return {
    persistenceOutbox,
    replace: (input) => handlers.get(shared.IPC.invoke.sessionReplaceMessages)(input),
    deleteMessage: (input) => handlers.get(shared.IPC.invoke.sessionDeleteMessage)(input),
    retractPendingPrompt: (input) => handlers.get(shared.IPC.invoke.sessionRetractPendingPrompt)(input),
    activateRevision: (input) => handlers.get(shared.IPC.invoke.sessionActivateRevision)(input),
    saveRevision: (input) => handlers.get(shared.IPC.invoke.sessionSaveRevision)(input),
  };
}
