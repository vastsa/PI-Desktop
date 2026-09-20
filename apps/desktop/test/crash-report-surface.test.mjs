import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  CRASH_DUMP_MARKER_FILE,
  CRASH_DUMPS_DIR_NAME,
  describeCrashDumps,
  ensureCrashDumpsDirectory,
  readCrashDumpMarker,
  reportPreviousCrashDumps,
  writeCrashDumpMarker,
} from "../electron/main/crash-report.ts";
import { readMainModule } from "./helpers/source-contracts.mjs";

/**
 * Crash collection has two halves: the scan/marker/report path below,
 * exercised against real files in a temp directory, and the main-process
 * wiring that starts Crashpad, held to the properties a behavior test cannot
 * observe without Electron (local-only reporter, dumps under dataDir, start
 * before ready).
 */
const startupSource = await readMainModule("bootstrap/startup.ts");
const mainIndexSource = await readMainModule("index.ts");

const parentDir = mkdtempSync(join(tmpdir(), "pi-desktop-crash-report-"));
test.after(() => {
  rmSync(parentDir, { recursive: true, force: true });
});

/** Whole-second mtimes keep the assertions filesystem-precision independent. */
const SECOND = 1_000;
const BASE_MS = 1_700_000_000_000;

function encodeMinidumpUtf8(s) {
  const buf = Buffer.alloc(4 + s.length + 1);
  buf.writeUInt32LE(s.length, 0);
  buf.write(s, 4, "ascii");
  buf[4 + s.length] = 0;
  return buf;
}

function crashpadDump(ptype, padBytes = 0) {
  return Buffer.concat([
    Buffer.from("MDMP"),
    encodeMinidumpUtf8("ptype"),
    Buffer.alloc(padBytes),
    encodeMinidumpUtf8(ptype),
  ]);
}

function makeDump(path, mtimeMs, contents) {
  mkdirSync(dirname(path), { recursive: true });
  const body =
    contents === undefined
      ? Buffer.from("minidump")
      : Buffer.isBuffer(contents)
        ? contents
        : crashpadDump(contents);
  writeFileSync(path, body);
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
}


function storedMarkerMtime(dataDir) {
  return readCrashDumpMarker(dataDir)?.newestMtimeMs ?? null;
}

function loggerSpy() {
  const records = [];
  return {
    records,
    logger: {
      app(category, level, message, fields) {
        records.push({ category, level, message, fields });
      },
    },
  };
}

function emptySummary(directory) {
  return {
    directory,
    dumpCount: 0,
    newDumpCount: 0,
    newestMtimeMs: null,
    newByProcessType: {},
  };
}

test("a crashDumps directory that does not exist yet reports nothing", () => {
  const summary = describeCrashDumps(join(parentDir, "never-created"));
  assert.deepEqual(summary, emptySummary(join(parentDir, "never-created")));
});

test("dumps are found under Crashpad's nested reports/ layout, and only .dmp files", () => {
  const root = join(parentDir, "crashDumps");
  makeDump(join(root, "reports", "older.dmp"), BASE_MS);
  makeDump(join(root, "reports", "newer.DMP"), BASE_MS + 60 * SECOND);
  makeDump(join(root, "crash.dmp"), BASE_MS + 30 * SECOND);
  // Not dumps: metadata beside the minidump, a directory ending in .dmp, and an
  // unrelated file.
  makeDump(join(root, "reports", "older.meta"), BASE_MS);
  mkdirSync(join(root, "decoy.dmp"), { recursive: true });
  writeFileSync(join(root, "notes.txt"), "not a dump");

  const summary = describeCrashDumps(root);
  assert.equal(summary.dumpCount, 3);
  assert.equal(summary.newDumpCount, 3);
  assert.equal(summary.newestMtimeMs, BASE_MS + 60 * SECOND);
  assert.deepEqual(summary.newByProcessType, { unknown: 3 });
});

test("a crash is reported once: the marker suppresses the repeat on the next launch", () => {
  const root = join(parentDir, "marker-scan");
  const dataDir = join(parentDir, "marker-scan-data");
  makeDump(join(root, "reports", "crashed-last-run.dmp"), BASE_MS);
  makeDump(join(root, "reports", "crashed-before-that.dmp"), BASE_MS - 120 * SECOND);
  assert.equal(readCrashDumpMarker(dataDir), null);

  // First launch: both dumps are new, so startup reports them and records the
  // newest mtime it saw.
  const firstScan = describeCrashDumps(root, storedMarkerMtime(dataDir));
  assert.equal(firstScan.dumpCount, 2);
  assert.equal(firstScan.newDumpCount, 2);
  writeCrashDumpMarker(dataDir, firstScan.newestMtimeMs);

  // Second launch: the same dumps are still on disk, but none is new.
  const secondScan = describeCrashDumps(root, storedMarkerMtime(dataDir));
  assert.equal(secondScan.dumpCount, 2);
  assert.equal(secondScan.newDumpCount, 0);
  assert.deepEqual(secondScan.newByProcessType, {});

  // A later crash is reported again, on the launch after it.
  makeDump(join(root, "reports", "crashed-again.dmp"), BASE_MS + 360 * SECOND);
  const afterNewCrash = describeCrashDumps(root, storedMarkerMtime(dataDir));
  assert.equal(afterNewCrash.newDumpCount, 1);
  assert.equal(afterNewCrash.newestMtimeMs, BASE_MS + 360 * SECOND);
});

test("the marker round-trips through the data-dir JSON store without leftover temps", () => {
  const dataDir = join(parentDir, "data");
  assert.equal(readCrashDumpMarker(dataDir), null);

  writeCrashDumpMarker(dataDir, BASE_MS);
  assert.deepEqual(readCrashDumpMarker(dataDir), { newestMtimeMs: BASE_MS });
  assert.equal(CRASH_DUMP_MARKER_FILE, "crash-dumps.json");
  assert.deepEqual(
    readdirSync(dataDir).filter((name) => name.startsWith("crash-dumps")),
    [CRASH_DUMP_MARKER_FILE],
  );
  if (process.platform !== "win32") {
    assert.equal(statSync(join(dataDir, CRASH_DUMP_MARKER_FILE)).mode & 0o777, 0o600);
  }

  writeFileSync(join(dataDir, CRASH_DUMP_MARKER_FILE), "{ not json");
  assert.equal(readCrashDumpMarker(dataDir), null);
  writeFileSync(join(dataDir, CRASH_DUMP_MARKER_FILE), JSON.stringify({ newestMtimeMs: "x" }));
  assert.equal(readCrashDumpMarker(dataDir), null);
});

test("ptype annotations classify Chromium process dumps", () => {
  const root = join(parentDir, "ptype");
  makeDump(join(root, "reports", "main.dmp"), BASE_MS, "browser");
  makeDump(join(root, "reports", "renderer.dmp"), BASE_MS + SECOND, "renderer");
  makeDump(join(root, "reports", "gpu.dmp"), BASE_MS + 2 * SECOND, "gpu-process");
  makeDump(join(root, "reports", "utility.dmp"), BASE_MS + 3 * SECOND, "utility");
  makeDump(join(root, "reports", "plain.dmp"), BASE_MS + 4 * SECOND);
  // A substring must not count as the key.
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(
    join(root, "reports", "decoy-key.dmp"),
    Buffer.from("MDMP\0notptype\0renderer\0", "latin1"),
  );
  utimesSync(
    join(root, "reports", "decoy-key.dmp"),
    new Date(BASE_MS + 5 * SECOND),
    new Date(BASE_MS + 5 * SECOND),
  );

  const summary = describeCrashDumps(root);
  assert.equal(summary.dumpCount, 6);
  assert.deepEqual(summary.newByProcessType, {
    main: 1,
    renderer: 1,
    gpu: 1,
    utility: 1,
    unknown: 2,
  });
});


test("Crashpad length-prefixed ptype survives padding; a C-string decoy does not classify", () => {
  const root = join(parentDir, "ptype-format");
  makeDump(join(root, "padded.dmp"), BASE_MS, crashpadDump("browser", 2));
  makeDump(
    join(root, "cstring.dmp"),
    BASE_MS + SECOND,
    Buffer.from("MDMP\0ptype\0browser\0", "latin1"),
  );
  const summary = describeCrashDumps(root);
  assert.deepEqual(summary.newByProcessType, { main: 1, unknown: 1 });
});

test("an unclassified dump is a warning, and a failed scan does not advance the marker", () => {
  const unknownRoot = join(parentDir, "unknown-only");
  const unknownData = join(parentDir, "unknown-only-data");
  makeDump(join(unknownRoot, "plain.dmp"), BASE_MS);
  const unknown = loggerSpy();
  reportPreviousCrashDumps({
    dataDir: unknownData,
    crashDumpsDirectory: unknownRoot,
    logger: unknown.logger,
  });
  assert.equal(unknown.records[0].level, "warn");
  assert.equal(unknown.records[0].fields.event, "crashDumpsFound");
  assert.equal(unknown.records[0].category, "diagnostics");

  const failedData = join(parentDir, "failed-marker-data");
  mkdirSync(failedData, { recursive: true });
  const notADir = join(parentDir, "failed-marker-not-dir");
  writeFileSync(notADir, "file");
  const failed = loggerSpy();
  reportPreviousCrashDumps({
    dataDir: failedData,
    crashDumpsDirectory: notADir,
    logger: failed.logger,
  });
  assert.equal(failed.records[0].fields.event, "crashDumpReportFailed");
  assert.equal(readCrashDumpMarker(failedData), null);

});

test("a recovered renderer dump is a warning; a main dump is an error", () => {
  const rendererRoot = join(parentDir, "report-renderer");
  const rendererData = join(parentDir, "report-renderer-data");
  makeDump(join(rendererRoot, "reports", "renderer.dmp"), BASE_MS, "renderer");
  const renderer = loggerSpy();
  reportPreviousCrashDumps({
    dataDir: rendererData,
    crashDumpsDirectory: rendererRoot,
    logger: renderer.logger,
  });
  assert.equal(renderer.records.length, 1);
  assert.equal(renderer.records[0].level, "warn");
  assert.equal(renderer.records[0].fields.event, "crashDumpsFound");
  assert.deepEqual(renderer.records[0].fields.data.byProcessType, { renderer: 1 });
  assert.equal(storedMarkerMtime(rendererData), BASE_MS);

  // Same dumps on the next launch: no repeat.
  const second = loggerSpy();
  reportPreviousCrashDumps({
    dataDir: rendererData,
    crashDumpsDirectory: rendererRoot,
    logger: second.logger,
  });
  assert.equal(second.records.length, 0);

  const mainRoot = join(parentDir, "report-main");
  const mainData = join(parentDir, "report-main-data");
  makeDump(join(mainRoot, "reports", "main.dmp"), BASE_MS, "browser");
  makeDump(join(mainRoot, "reports", "renderer.dmp"), BASE_MS + SECOND, "renderer");
  const main = loggerSpy();
  reportPreviousCrashDumps({
    dataDir: mainData,
    crashDumpsDirectory: mainRoot,
    logger: main.logger,
  });
  assert.equal(main.records[0].level, "error");
  assert.equal(
    main.records[0].message,
    "crash dumps found from a previous process crash",
  );
  assert.deepEqual(main.records[0].fields.data.byProcessType, { main: 1, renderer: 1 });
});

test("a scan that is not a missing directory is reported, and never thrown", () => {
  const notADir = join(parentDir, "not-a-crash-dir");
  writeFileSync(notADir, "this is a file");
  assert.throws(() => describeCrashDumps(notADir));

  const spy = loggerSpy();
  reportPreviousCrashDumps({
    dataDir: join(parentDir, "not-a-crash-data"),
    crashDumpsDirectory: notADir,
    logger: spy.logger,
  });
  assert.equal(spy.records.length, 1);
  assert.equal(spy.records[0].level, "warn");
  assert.equal(spy.records[0].fields.event, "crashDumpReportFailed");
});

test("ensureCrashDumpsDirectory is the installation-local Crashpad root", () => {
  const dataDir = join(parentDir, "install-data");
  const directory = ensureCrashDumpsDirectory(dataDir);
  assert.equal(directory, join(dataDir, CRASH_DUMPS_DIR_NAME));
  assert.equal(statSync(directory).isDirectory(), true);
});

test("startup starts Crashpad local-only, under dataDir, before ready", () => {
  assert.match(startupSource, /crashReporter\.start\(\{\s*uploadToServer: false,/);
  assert.match(startupSource, /productName: APP_NAME/);
  assert.match(
    startupSource,
    /app\.setPath\(\s*"crashDumps",\s*ensureCrashDumpsDirectory\(deps\.dataDir\)\s*\)/,
  );
  assert.match(startupSource, /try \{\s*app\.setPath\(\s*"crashDumps"/);
  assert.match(startupSource, /event: "crashReporterStartFailed"/);
  const setAt = startupSource.indexOf('app.setPath("crashDumps"');
  const startAt = startupSource.indexOf("crashReporter.start(");
  assert.ok(setAt > 0, "startup must relocate the crash dumps directory");
  assert.ok(setAt < startAt, "the dumps path must be set before the reporter starts");
  assert.ok(
    startAt < startupSource.indexOf("app.whenReady()"),
    "the reporter must start before the app is ready",
  );
  // One installation point: the composition root does not start it again.
  assert.doesNotMatch(mainIndexSource, /crashReporter\.start/);
});

test("startup reports new crash dumps after the single-instance lock", () => {
  assert.match(
    startupSource,
    /reportPreviousCrashDumps\(\{\s*dataDir,\s*crashDumpsDirectory:\s*app\.getPath\(\s*"crashDumps"\s*\),\s*logger,/,
  );
  const lockAt = startupSource.indexOf("if (!hasSingleInstanceLock) return;");
  const reportAt = startupSource.indexOf("reportPreviousCrashDumps(");
  assert.ok(lockAt > 0 && reportAt > lockAt, "only the lock holder reports dumps");
});
