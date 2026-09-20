/**
 * Local crash-dump collection for the Electron main process.
 *
 * Electron ships Crashpad, so `crashReporter.start()` needs no native
 * dependency. Dumps stay on this machine — nothing is uploaded — and this
 * module only describes what is already on disk plus the marker of the last
 * scan, so a Chromium-process crash becomes one durable log line instead of
 * staying invisible.
 *
 * Crashpad collects dumps from every Chromium process it was started for
 * (main, renderer, GPU, utility), not only a main-process abort. A renderer
 * crash the app already recovered still leaves a dump; the next-launch line
 * therefore classifies dumps by Crashpad's `ptype` annotation and logs
 * recovered child crashes at warn rather than claiming the previous run died.
 *
 * Crashpad nests dumps under subdirectories of `app.getPath("crashDumps")`
 * (for example `reports/`), so the scan walks a bounded depth instead of
 * assuming a flat directory: a flat readdir finds zero dumps and the feature
 * would be silently useless. The dumps directory itself is relocated under
 * the installation data directory so a `PI_DESKTOP_DATA_DIR` profile does
 * not share dumps with another installation.
 *
 * Crashes of the host-core / sidecar children are out of scope here: main
 * supervises and restarts those processes (see `runtime/lifecycle.ts`) and
 * their stderr already lands in the `host` / `agent` log channels.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

import type { Dirent } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./logger";

/** Crashpad uses one nesting level; three leaves room without a full walk. */
const MAX_DUMP_SCAN_DEPTH = 3;


/** Marker file, beside the other best-effort main-process state JSON. */
export const CRASH_DUMP_MARKER_FILE = "crash-dumps.json";

/** Installation-local Crashpad root, under the data directory. */
export const CRASH_DUMPS_DIR_NAME = "crash-dumps";

export type CrashDumpProcessType =
  | "main"
  | "renderer"
  | "gpu"
  | "utility"
  | "unknown";

export type CrashDumpSummary = {
  /** Directory that was scanned. */
  directory: string;
  /** Every `*.dmp` file that could be stated at or below `directory`. */
  dumpCount: number;
  /** Dumps strictly newer than the caller's marker mtime. */
  newDumpCount: number;
  /** Newest mtime across every dump found, or null when there is none. */
  newestMtimeMs: number | null;
  /** Process types of dumps strictly newer than the marker. */
  newByProcessType: Partial<Record<CrashDumpProcessType, number>>;
};

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}

function collectDumpPaths(directory: string, depth: number, found: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    // Crashpad has not created this directory yet: skip just this branch.
    // Any other failure (EACCES, ENOTDIR, EIO) is a real scan error.
    if (isEnoent(error)) return;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0) collectDumpPaths(path, depth - 1, found);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".dmp")) {
      found.push(path);
    }
  }
}

/**
 * Crashpad annotations are `MinidumpUTF8String` objects: a little-endian
 * `uint32` length, the bytes, then a NUL. Electron sets `ptype` to Chromium's
 * process name (`browser`, `renderer`, `gpu-process`, `utility`, …). Key and
 * value are separate objects, usually packed next to each other with up to
 * four bytes of padding. This is a bounded scan, not a minidump parser: a
 * miss reports `unknown` rather than guessing.
 */
function readMinidumpUtf8(
  contents: Buffer,
  offset: number,
): { value: string; bytes: number } | null {
  if (offset < 0 || offset + 5 > contents.length) return null;
  const length = contents.readUInt32LE(offset);
  if (length < 1 || length > 32) return null;
  const start = offset + 4;
  const nul = start + length;
  if (nul >= contents.length || contents[nul] !== 0) return null;
  const value = contents.toString("latin1", start, start + length);
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(value)) return null;
  return { value, bytes: 4 + length + 1 };
}

function encodeMinidumpUtf8Key(key: string): Buffer {
  const encoded = Buffer.alloc(4 + key.length + 1);
  encoded.writeUInt32LE(key.length, 0);
  encoded.write(key, 4, "latin1");
  encoded[4 + key.length] = 0;
  return encoded;
}

function readCrashpadAnnotation(contents: Buffer, key: string): string | null {
  const keyEncoded = encodeMinidumpUtf8Key(key);
  let from = 0;
  while (from <= contents.length - keyEncoded.length) {
    const idx = contents.indexOf(keyEncoded, from);
    if (idx < 0) return null;
    const afterKey = idx + keyEncoded.length;
    for (const pad of [0, 1, 2, 3, 4]) {
      const parsed = readMinidumpUtf8(contents, afterKey + pad);
      if (parsed) return parsed.value;
    }
    from = idx + 1;
  }
  return null;
}

function classifyProcessType(raw: string | null): CrashDumpProcessType {
  if (raw === "browser" || raw === "main") return "main";
  if (raw === "renderer") return "renderer";
  if (raw === "gpu" || raw === "gpu-process") return "gpu";
  if (
    raw === "utility" ||
    raw === "plugin" ||
    raw === "ppapi" ||
    raw === "zygote" ||
    raw === "sandbox"
  ) {
    return "utility";
  }
  return "unknown";
}

/** Head+tail is enough: CrashpadInfo is a stream, not guaranteed to be first. */
const ANNOTATION_SCAN_SLICE = 512 * 1024;

function readDumpForAnnotations(path: string): Buffer {
  const size = statSync(path).size;
  if (size <= ANNOTATION_SCAN_SLICE * 2) return readFileSync(path);
  const fd = openSync(path, "r");
  try {
    const head = Buffer.alloc(ANNOTATION_SCAN_SLICE);
    const tail = Buffer.alloc(ANNOTATION_SCAN_SLICE);
    readSync(fd, head, 0, ANNOTATION_SCAN_SLICE, 0);
    readSync(fd, tail, 0, ANNOTATION_SCAN_SLICE, size - ANNOTATION_SCAN_SLICE);
    return Buffer.concat([head, Buffer.alloc(4), tail]);
  } finally {
    closeSync(fd);
  }
}

function processTypeOfDump(path: string): CrashDumpProcessType {
  try {
    return classifyProcessType(readCrashpadAnnotation(readDumpForAnnotations(path), "ptype"));
  } catch {
    // Unreadable dump: still counted, but not guessed as main.
    return "unknown";
  }
}


function incrementType(
  counts: Partial<Record<CrashDumpProcessType, number>>,
  type: CrashDumpProcessType,
): void {
  counts[type] = (counts[type] ?? 0) + 1;
}

/**
 * Describe the dumps below `directory`, and how many of them are newer than
 * `sinceMtimeMs` (the previous launch's marker; null reports every dump).
 * Filesystem races stay benign: a dump removed between list and stat is not a
 * dump for this scan, and a directory that does not exist is an empty scan.
 * Permission and type errors propagate so a broken tree is observable.
 */
export function describeCrashDumps(
  directory: string,
  sinceMtimeMs: number | null = null,
): CrashDumpSummary {
  const found: string[] = [];
  collectDumpPaths(directory, MAX_DUMP_SCAN_DEPTH, found);
  let dumpCount = 0;
  let newDumpCount = 0;
  let newestMtimeMs: number | null = null;
  const newByProcessType: Partial<Record<CrashDumpProcessType, number>> = {};
  for (const path of found) {
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch (error) {
      if (isEnoent(error)) continue; // removed between readdir and stat
      throw error;
    }
    dumpCount += 1;
    if (newestMtimeMs === null || mtimeMs > newestMtimeMs) newestMtimeMs = mtimeMs;
    if (sinceMtimeMs === null || mtimeMs > sinceMtimeMs) {
      newDumpCount += 1;
      incrementType(newByProcessType, processTypeOfDump(path));
    }
  }
  return { directory, dumpCount, newDumpCount, newestMtimeMs, newByProcessType };
}

export type CrashDumpMarker = { newestMtimeMs: number };

/** Read the previous scan's marker; missing or malformed reads as "unset". */
export function readCrashDumpMarker(dataDir: string): CrashDumpMarker | null {
  try {
    const raw = JSON.parse(
      readFileSync(join(dataDir, CRASH_DUMP_MARKER_FILE), "utf8"),
    ) as { newestMtimeMs?: unknown };
    const newestMtimeMs = Number(raw?.newestMtimeMs);
    return Number.isFinite(newestMtimeMs) ? { newestMtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * Persist the newest mtime a scan saw, so the next launch reports only dumps
 * from crashes after this one. Best-effort, like the other main-process state
 * files: failing to write the marker repeats a log line on the next launch,
 * which is better than turning a diagnostic into a boot failure. The write is
 * temp-plus-rename so a crash mid-write cannot truncate a previously good
 * marker into malformed JSON.
 */
export function writeCrashDumpMarker(dataDir: string, newestMtimeMs: number): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    const destination = join(dataDir, CRASH_DUMP_MARKER_FILE);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ newestMtimeMs }), {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(temporary, destination);
    } finally {
      rmSync(temporary, { force: true });
    }
  } catch {
    // best-effort persistence
  }
}

export function crashDumpsDirectory(dataDir: string): string {
  return join(dataDir, CRASH_DUMPS_DIR_NAME);
}

/** Create the installation-local Crashpad root and return it. */
export function ensureCrashDumpsDirectory(dataDir: string): string {
  const directory = crashDumpsDirectory(dataDir);
  mkdirSync(directory, { recursive: true });
  return directory;
}

/**
 * One diagnostics line per new dump set, then advance the marker. A failure
 * here is a warning: it never blocks the first window.
 */
export function reportPreviousCrashDumps(input: {
  dataDir: string;
  crashDumpsDirectory: string;
  logger: Pick<Logger, "app">;
}): void {
  try {
    const crashDumpMarker = readCrashDumpMarker(input.dataDir)?.newestMtimeMs ?? null;
    const crashDumps = describeCrashDumps(input.crashDumpsDirectory, crashDumpMarker);
    if (crashDumps.newDumpCount > 0) {
      const level = (crashDumps.newByProcessType.main ?? 0) > 0 ? "error" : "warn";
      input.logger.app(
        "diagnostics",
        level,
        "crash dumps found from a previous process crash",
        {
          event: "crashDumpsFound",
          data: {
            count: crashDumps.newDumpCount,
            total: crashDumps.dumpCount,
            byProcessType: crashDumps.newByProcessType,
            directory: crashDumps.directory,
            newestMtimeMs: crashDumps.newestMtimeMs,
          },
        },
      );
    }
    if (
      crashDumps.newestMtimeMs !== null &&
      (crashDumpMarker === null || crashDumps.newestMtimeMs > crashDumpMarker)
    ) {
      writeCrashDumpMarker(input.dataDir, crashDumps.newestMtimeMs);
    }
  } catch (error) {
    input.logger.app("diagnostics", "warn", "crash dump report failed", {
      event: "crashDumpReportFailed",
      data: String(error),
    });
  }
}
