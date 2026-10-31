import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { loadRemoteWorkspaceInstructions } = await import("../electron/main/remote/remote-workspace-instructions.ts");
const { createWorkspaceFiles } = await import("../../pi-host/src/workspace-files.ts");

test("local Agent configuration loads remote repository instructions after local defaults", async () => {
  const root = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? tmpdir(), "remote-instructions-"));
  try {
    const path = join(root, "remote-repo");
    await mkdir(path);
    await writeFile(join(root, "AGENTS.md"), "parent must not be loaded");
    await writeFile(join(path, "AGENTS.md"), "remote repository policy");
    const defaults = { entries: [{ source: "~/.pi/agent/AGENTS.md", content: "local user defaults" }] };
    const files = createWorkspaceFiles();
    const requests = [];
    const loaded = await loadRemoteWorkspaceInstructions(async (hostKey, input) => {
      requests.push({ hostKey, input });
      return files.read(input);
    }, { hostKey: "paired", path }, defaults);
    assert.deepEqual(requests, [{ hostKey: "paired", input: { path, operation: "instructions" } }]);
    assert.deepEqual(loaded, { entries: [...defaults.entries, { source: "AGENTS.md", content: "remote repository policy" }] });
    await rm(join(path, "AGENTS.md"));
    assert.deepEqual(await loadRemoteWorkspaceInstructions((_key, input) => files.read(input), { hostKey: "paired", path }, defaults), defaults);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("offline instruction loading fails without a local fallback", async () => {
  const offline = Object.assign(new Error("Host disconnected"), { errorCode: "HOST_DISCONNECTED" });
  await assert.rejects(loadRemoteWorkspaceInstructions(async () => { throw offline; }, { hostKey: "paired", path: "/repo" }), (error) => error === offline);
});

for (const value of [undefined, { entries: "bad" }, { entries: [{ source: "~/.pi/agent/AGENTS.md", content: "remote home" }] }, { entries: [{ source: "../AGENTS.md", content: "outside" }] }, { entries: [{ source: "AGENTS.md", content: "x".repeat(33_281) }] }, { entries: [{ source: "AGENTS.md", content: 42 }] }]) {
  test("rejects malformed or out-of-scope Host instructions", async () => {
    await assert.rejects(loadRemoteWorkspaceInstructions(async () => value, { hostKey: "paired", path: "/repo" }), { errorCode: "INVALID_ARGUMENT" });
  });
}
