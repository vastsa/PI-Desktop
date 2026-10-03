import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relativePath) => readFile(new URL(relativePath, import.meta.url), "utf8");

const [loader, sessionLaunch, skillsIpc, register] = await Promise.all([
  read("../../../packages/agent-runtime/src/subagent-definitions.ts"),
  read("../electron/main/runtime/session-launch.ts"),
  read("../electron/main/ipc/skills-ipc.ts"),
  read("../electron/main/ipc/register.ts"),
]);

test("the loader owns the override directory constant and option (ADR 0319)", () => {
  // One constant, so Electron main and the loader cannot drift apart on the
  // directory name.
  assert.match(
    loader,
    /export function builtinSubagentOverridesDir\(dataDir: string\): string \{\s*return join\(dataDir, "subagent-overrides"\);/,
  );
  assert.match(loader, /builtinOverridesDir\?: string;/);
  // Overrides parse as builtin source, so the Settings switch (ADR 0270)
  // keeps governing the handle, and only a builtin name is retunable.
  assert.match(loader, /loadDirDocuments\(dir, "builtin"\)/);
  assert.match(loader, /override matches no builtin/);
  assert.match(loader, /new delegates belong in ~\/\.agents\/subagents/);
  // The merge feeds overrides ahead of the shipped constants but behind the
  // user's registry documents.
  assert.match(
    loader,
    /\.\.\.disk\.definitions,\s*\.\.\.user\.definitions,\s*\.\.\.overrides\.definitions,\s*\.\.\.builtin\.definitions,/,
  );
});

test("session launch reads the override directory on every prompt", () => {
  assert.match(sessionLaunch, /builtinSubagentOverridesDir,/);
  assert.match(
    sessionLaunch,
    /builtinOverridesDir: builtinSubagentOverridesDir\(dataDir\),/,
  );
});

test("the settings catalog shows retuned builtins from the same directory", () => {
  assert.match(skillsIpc, /builtinOverridesDir: string;/);
  assert.match(skillsIpc, /  builtinOverridesDir,\n  stripWinLongPrefix,/);
  const start = skillsIpc.indexOf("IPC.invoke.subagentCatalog");
  const end = skillsIpc.indexOf("IPC.invoke.subagentCreate", start);
  const handler = skillsIpc.slice(start, end);
  assert.ok(start >= 0 && end > start, "subagent catalog handler should exist");
  assert.match(handler, /disabledBuiltins: disabled,\s*builtinOverridesDir,/);
});

test("IPC registration wires the data dir into the skills channels", () => {
  assert.match(
    register,
    /import \{ builtinSubagentOverridesDir \} from "@pi-desktop\/agent-runtime";/,
  );
  assert.match(
    register,
    /builtinOverridesDir: builtinSubagentOverridesDir\(dataDir\),/,
  );
});
