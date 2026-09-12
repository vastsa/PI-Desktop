import {
  readAppSourceSync,
  readMainModuleSync,
  readMainSourceSync,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARCH_MISMATCH_STATUS,
  DB_SCHEMA_TOO_NEW_STATUS,
  DbSchemaTooNewError,
  detectRuntimeArch,
  isDbSchemaTooNewError,
  normalizeMachineArch,
  parseSchemaTooNew,
  schemaTooNewOf,
} from "../electron/main/host-boot-diagnostics.ts";

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(desktopRoot, "../..");
const read = (rel) => readFileSync(join(desktopRoot, rel), "utf8");
const mainSrc = readMainSourceSync();
const lifecycleSrc = readMainModuleSync("runtime/lifecycle.ts");
const hostSrc = read("electron/main/host-process.ts");
const appSrc = readAppSourceSync();
const enSrc = readFileSync(join(repoRoot, "packages/i18n/src/locales/en/index.ts"), "utf8");
const zhSrc = readFileSync(join(repoRoot, "packages/i18n/src/locales/zh-CN/index.ts"), "utf8");

const HOST_CORE_LINE =
  "Error: database schema version 14 is newer than supported 13";

test("host-core's downgrade refusal is parsed from stderr", () => {
  assert.deepEqual(parseSchemaTooNew(HOST_CORE_LINE), { found: 14, supported: 13 });
  assert.deepEqual(
    parseSchemaTooNew(`2026-09-10T03:46:01Z ERROR ${HOST_CORE_LINE}\n`),
    { found: 14, supported: 13 },
  );
  assert.equal(parseSchemaTooNew("host-core exited"), null);
  assert.equal(parseSchemaTooNew(undefined), null);
});

test("the schema error keeps both numbers and is recognised in every shape", () => {
  const error = new DbSchemaTooNewError({ found: 14, supported: 13 });
  assert.equal(error.code, DB_SCHEMA_TOO_NEW_STATUS);
  assert.match(error.message, /schema 14/);
  assert.match(error.message, /supports 13/);
  assert.deepEqual(schemaTooNewOf(error), { found: 14, supported: 13 });
  assert.deepEqual(
    schemaTooNewOf({ code: DB_SCHEMA_TOO_NEW_STATUS, found: 9, supported: 8 }),
    { found: 9, supported: 8 },
  );
  assert.deepEqual(schemaTooNewOf(new Error(HOST_CORE_LINE)), { found: 14, supported: 13 });
  assert.equal(isDbSchemaTooNewError(new Error("host-core exited")), false);
  assert.equal(isDbSchemaTooNewError(null), false);
});

test("machine architectures normalise to Node's arch names", () => {
  assert.equal(normalizeMachineArch("x86_64"), "x64");
  assert.equal(normalizeMachineArch("AMD64"), "x64");
  assert.equal(normalizeMachineArch("aarch64"), "arm64");
  assert.equal(normalizeMachineArch("arm64"), "arm64");
  assert.equal(normalizeMachineArch("i686"), "ia32");
});

test("an Intel build under Rosetta is a mismatch; native builds are not", () => {
  const rosetta = detectRuntimeArch({
    platform: "darwin",
    processArch: "x64",
    machine: "x86_64",
    darwinTranslated: true,
  });
  assert.deepEqual(rosetta, {
    platform: "darwin",
    processArch: "x64",
    machineArch: "arm64",
    mismatch: true,
  });
  assert.equal(
    detectRuntimeArch({
      platform: "darwin",
      processArch: "x64",
      machine: "x86_64",
      darwinTranslated: false,
    }).mismatch,
    false,
  );
  assert.equal(
    detectRuntimeArch({
      platform: "darwin",
      processArch: "arm64",
      machine: "arm64",
      darwinTranslated: false,
    }).mismatch,
    false,
  );
  assert.equal(
    detectRuntimeArch({ platform: "linux", processArch: "x64", machine: "aarch64" }).mismatch,
    true,
  );
  assert.equal(
    detectRuntimeArch({ platform: "win32", processArch: "x64", machine: "x86_64" }).mismatch,
    false,
  );
  assert.equal(ARCH_MISMATCH_STATUS, "ARCH_MISMATCH");
});

test("host-process turns the refusal into a typed error before glibc matching", () => {
  const body = hostSrc.slice(hostSrc.indexOf("private unavailableError("));
  const schemaAt = body.indexOf("parseSchemaTooNew(this.lastStderr)");
  const glibcAt = body.indexOf("glibcMissingSymbol(this.lastStderr)");
  assert.ok(schemaAt > 0 && glibcAt > 0);
  assert.ok(schemaAt < glibcAt, "schema refusal must be checked first");
  assert.match(body, /new DbSchemaTooNewError\(schema\)/);
});

test("main stops restarting on a schema refusal and pushes a named status", () => {
  const loop = lifecycleSrc.slice(lifecycleSrc.indexOf("async function superviseRestartLoop("));
  const schemaAt = loop.indexOf("schemaTooNewOf(error)");
  const glibcAt = loop.indexOf("isGlibcUnsupportedError(error)");
  assert.ok(schemaAt > 0 && schemaAt < glibcAt);
  assert.match(loop.slice(schemaAt, glibcAt), /message: DB_SCHEMA_TOO_NEW_STATUS,\s*schema,\s*\}\);\s*return;/);
  const boot = lifecycleSrc.slice(lifecycleSrc.indexOf("const bootHostStatus ="));
  assert.match(boot, /status\.message = DB_SCHEMA_TOO_NEW_STATUS;\s*status\.schema = schema;/);
  assert.match(boot, /status\.archMismatch = \{/);
  assert.match(mainSrc, /sendToRenderer\(IPC\.event\.hostStatus, bootHostStatus\(bootError\)\);/);
});

test("the renderer phrases both notices in every locale", () => {
  assert.match(appSrc, /backendDown\.message === "DB_SCHEMA_TOO_NEW"/);
  assert.match(appSrc, /t\("status\.dbSchemaTooNew", \{\s*found:/);
  assert.match(appSrc, /if \(status\.archMismatch\) setArchMismatch\(status\.archMismatch\);/);
  assert.match(appSrc, /t\("status\.archMismatch", \{/);
  assert.match(appSrc, /status\.archNames\.\$\{archMismatch\.platform\}\.\$\{archMismatch\.processArch\}/);
  for (const src of [enSrc, zhSrc]) {
    assert.match(src, /dbSchemaTooNew:\s*"[^"]*\{\{found\}\}[^"]*\{\{supported\}\}/);
    assert.match(src, /archMismatch:\s*"[^"]*\{\{buildArch\}\}[^"]*\{\{machineArch\}\}/);
    assert.match(src, /dismissArchMismatch: "/);
    assert.match(src, /darwin: \{ x64: "Intel", arm64: "Apple Silicon" \}/);
  }
});
