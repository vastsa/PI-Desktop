#!/usr/bin/env node
/** Native installation-lock regression; retain all synthetic files after testing. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
await mkdir(join(root, ".artifacts"), { recursive: true });
const artifacts = await realpath(await mkdtemp(join(root, ".artifacts/storage-backup-lock-")));
for (const name of ["installation", "active-data", "active-browser"]) await mkdir(join(artifacts, name));
await writeFile(join(artifacts, "installation/storage-location.json"), "retained pointer");
await writeFile(join(artifacts, "active-data/history.txt"), "current history");
const { build } = createRequire(join(root, "packages/agent-runtime/package.json"))("esbuild");
const main = join(artifacts, "main.mjs");
await build({ entryPoints: [join(root, "scripts/e2e/storage-backup-lock-main.mjs")],
  outfile: main, bundle: true, platform: "node", format: "esm", external: ["electron", "original-fs"] });
const env = { ...process.env, PI_STORAGE_BACKUP_ARTIFACTS: artifacts };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(resolveElectronBinary(root).electronBinary, [main], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output += chunk; });
const timeout = setTimeout(() => child.kill(), 30000);
let code;
try { code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); }); }
finally { clearTimeout(timeout); await writeFile(join(artifacts, "electron.log"), output); }
const report = JSON.parse(await readFile(join(artifacts, "result.json"), "utf8"));
console.log(JSON.stringify({ artifacts, ...report }, null, 2));
assert.equal(code, 0, report.error ?? output);
assert(report.passed);
