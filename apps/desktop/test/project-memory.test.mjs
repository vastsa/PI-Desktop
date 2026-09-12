import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), "utf8");

const [dialog, page, api, protocol, main, runtime, sidecar, db, rpc] = await Promise.all([
  read("../src/components/ProjectMemoryDialog.tsx"),
  read("../src/pages/ProjectsPage.tsx"),
  read("../src/lib/api.ts"),
  read("../../../packages/shared/src/protocol.ts"),
  read("../electron/main/index.ts"),
  read("../../../packages/agent-runtime/src/runtime.ts"),
  read("../../../packages/agent-runtime/src/sidecar.ts"),
  read("../../../crates/host-core/src/db.rs"),
  read("../../../crates/host-core/src/rpc/mod.rs"),
]);

test("project memory has a host-backed editor and project menu entry", () => {
  assert.match(dialog, /api\.getProjectMemory\(project\.path\)/);
  assert.match(dialog, /api\.saveProjectMemory\(project\.path, draft\)/);
  assert.match(dialog, /project\.memoryDescription/);
  assert.match(page, /ProjectMemoryDialog/);
  assert.match(page, /project\.editMemory/);
});

test("project memory crosses the IPC and runtime boundary", () => {
  assert.match(protocol, /projectMemoryGet/);
  assert.match(protocol, /projectMemorySave/);
  assert.match(api, /getProjectMemory/);
  assert.match(api, /saveProjectMemory/);
  assert.match(main, /project\.memory\.get/);
  assert.match(main, /project\.memory\.set/);
  assert.match(main, /projectMemory/);
  assert.match(sidecar, /projectMemory: params\.projectMemory/);
  assert.match(runtime, /projectMemoryPrompt/);
  assert.match(runtime, /config\.projectMemory/);
  assert.match(db, /PROJECT_MEMORY_NAMESPACE/);
  assert.match(db, /MAX_PROJECT_MEMORY_BYTES/);
  assert.match(rpc, /"project\.memory\.get"/);
  assert.match(rpc, /"project\.memory\.set"/);
});
