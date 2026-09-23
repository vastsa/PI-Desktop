import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readMainSource } from "./helpers/main-source.mjs";

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), "utf8");

const [dialog, page, api, protocol, main, runtime, sidecar, db, groups, rpc] = await Promise.all([
  read("../src/components/ProjectMemoryDialog.tsx"),
  read("../src/pages/ProjectsPage.tsx"),
  read("../src/lib/api.ts"),
  read("../../../packages/shared/src/protocol.ts"),
  readMainSource(),
  read("../../../packages/agent-runtime/src/runtime.ts"),
  read("../../../packages/agent-runtime/src/sidecar.ts"),
  read("../../../crates/host-core/src/db/repositories.rs"),
  read("../../../crates/host-core/src/db/project_groups.rs"),
  read("../../../crates/host-core/src/rpc/mod.rs"),
]);

test("project memory has a host-backed editor and project menu entry", () => {
  assert.match(dialog, /useProjectMemoryEditor/);
  assert.match(api, /getProjectMemoryEditor/);
  assert.match(api, /saveProjectMemoryEditor/);
  assert.match(dialog, /project\.memoryAdd/);
  assert.match(dialog, /project\.memoryRemove/);
  assert.doesNotMatch(dialog, /project\.memorySourceManual|project\.autoMemorySource|project-memory-source/);
  assert.match(dialog, /project\.memoryDescription/);
  assert.match(page, /ProjectMemoryDialog/);
  assert.match(page, /project\.editMemory/);
});

test("project memory crosses the IPC and runtime boundary", () => {
  assert.match(protocol, /projectMemoryGet/);
  assert.match(protocol, /projectMemorySave/);
  assert.match(protocol, /projectMemoryEditorGet/);
  assert.match(protocol, /projectMemoryEditorSave/);
  assert.match(protocol, /projectGroupMemorySave/);
  assert.match(api, /getProjectGroupMemory/);
  assert.match(api, /saveProjectGroupMemory/);
  assert.match(main, /project\.group\.memory\.get/);
  assert.match(main, /project\.group\.memory\.set/);
  assert.match(rpc, /project\.group\.context/);
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
  assert.match(groups, /GROUP_NAMESPACE/);
  assert.match(groups, /project_group_context_for_path/);
  assert.match(rpc, /resolve_tool_workspace_for_call/);
  assert.match(rpc, /"project\.memory\.get"/);
  assert.match(rpc, /"project\.memory\.set"/);
});
