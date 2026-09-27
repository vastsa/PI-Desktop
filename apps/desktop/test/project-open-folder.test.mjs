import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (relativePath) =>
  readFile(new URL(relativePath, import.meta.url), "utf8");

const [protocolSource, apiSource, mainSource] = await Promise.all([
  read("../../../packages/shared/src/protocol.ts"),
  read("../src/lib/api.ts"),
  read("../electron/main/index.ts"),
]);

test("open-folder is exposed as a project-only IPC action", () => {
  assert.match(
    protocolSource,
    /projectOpenFolder:\s*"pi-desktop\/project\/openFolder"/,
  );
  assert.doesNotMatch(protocolSource, /sessionOpenFolder/);
  assert.match(
    apiSource,
    /openProjectFolder:\s*\(path: string\)[\s\S]*?IPC\.invoke\.projectOpenFolder, path/,
  );
  assert.doesNotMatch(apiSource, /openSessionFolder/);
});

test("main opens only a registered project directory", () => {
  const start = mainSource.indexOf("handle(IPC.invoke.projectOpenFolder");
  const end = mainSource.indexOf("handle(IPC.invoke.projectOpen,", start);
  const handler = mainSource.slice(start, end);

  assert.ok(start >= 0 && end > start, "project open-folder handler should exist");
  assert.match(handler, /host\.call\("projects\.list"\)/);
  assert.match(handler, /resolve\(candidate\) === projectPath/);
  assert.match(handler, /ErrorCodes\.INVALID_ARGUMENT/);
  assert.match(handler, /ErrorCodes\.NOT_FOUND/);
  assert.match(handler, /statSync\(projectPath\)\.isDirectory\(\)/);
  assert.match(handler, /shell\.openPath\(stripWinLongPrefix\(projectPath\)\)/);
  assert.match(handler, /return \{ ok: true, path: projectPath \}/);
});
