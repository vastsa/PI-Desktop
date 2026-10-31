#!/usr/bin/env node
/** Real Electron filesystem migration; synthetic files only, retained for diagnosis. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
await mkdir(join(root, ".artifacts"), { recursive: true });
const artifacts = await realpath(await mkdtemp(join(root, ".artifacts/storage-files-e2e-")));
const junctionFixture = join(artifacts, "node-created-junction");
await mkdir(join(junctionFixture, "data"), { recursive: true });
await mkdir(join(junctionFixture, "browser"));
await symlink(join(junctionFixture, "missing-dependency"), join(junctionFixture, "data", "node_modules"), process.platform === "win32" ? "junction" : "dir");
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const desktopRequire = createRequire(join(root, "apps/desktop/package.json"));
const builderRequire = createRequire(desktopRequire.resolve("electron-builder"));
const { createPackage } = createRequire(builderRequire.resolve("app-builder-lib"))("@electron/asar");
const archiveSource = join(artifacts, "archive-source");
await mkdir(archiveSource);
await writeFile(join(archiveSource, "index.js"), "module.exports = 'synthetic archive';\n");
await createPackage(archiveSource, join(artifacts, "fixture.asar"));
const main = join(artifacts, "main.mjs");
await build({ entryPoints: [join(root, "scripts/e2e/storage-files-main.mjs")],
  outfile: main, bundle: true, platform: "node", format: "esm", external: ["electron", "original-fs"] });
const env = { ...process.env, PI_STORAGE_FILES_ARTIFACTS: artifacts };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(resolveElectronBinary(root).electronBinary, [main], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output += data; });
const timeout = setTimeout(() => child.kill(), 60000);
let code;
try { code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); }); }
finally { clearTimeout(timeout); await writeFile(join(artifacts, "electron.log"), output); }
const report = JSON.parse(await readFile(join(artifacts, "result.json"), "utf8"));
console.log(JSON.stringify({ artifacts, ...report }, null, 2));
assert.equal(code, 0, output);
assert(report.cases.every(value => value.passed), JSON.stringify(report.cases));
