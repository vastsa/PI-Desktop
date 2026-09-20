#!/usr/bin/env node
// Inventory the payload that @electron/osx-sign is about to sign.
//
// Why this exists: osx-sign walks the whole `PI-Desktop.app` and runs one
// `codesign --sign ... --force --timestamp --entitlements ...` per signing
// candidate, strictly serially. "How long will signing take?" is therefore a
// function of how many candidates and bytes the bundle contains, and of which
// of them sit in unexpected places. This script answers that from the built
// artifact, before anything is signed.
//
// What counts as a candidate: @electron/osx-sign@1.3.3 calls
// `getFilePathIfBinary()` (isbinaryfile content detection) for *every* file it
// walks, so it signs far more than the Mach-O files and nested bundles: any
// resource that merely looks binary gets its own `codesign` call too. One real
// signed PI-Desktop.app produced 91 invocations distributed over extensions
// `.pak` 33, extensionless 24, `.dylib` 12, `.app` 5, `.framework` 4, `.nib` 3,
// `.dat` 3, `.bin` 3, `.png` 2, `.asar` 1, `.icns` 1. Counting just Mach-O
// files and nested bundles understates that work by roughly 4x, which is why
// `binary-resources` exists and why `signing-candidates` includes it.
//
// Usage:
//   node scripts/macos-bundle-inventory.mjs <path> [--json] [--top <n>]
//
//   <path> is either a `*.app` directory or the electron-builder release
//   directory, which must contain exactly one `*.app` one level down (for
//   example `release/mac-arm64/PI-Desktop.app`). `--json` appends one
//   machine-readable line prefixed with `inventory-json: `; `--top <n>` sets
//   how many entries the `top-level-cost` and `slowest-likely` lines list
//   (default 5).
//
// Byte accounting: every size is the sum of `st_size` (the file's logical
// length, not on-disk block usage) of the regular files below that directory.
// Directory symlinks are never followed: osx-sign walks real directories, and
// not following them keeps every directory counted exactly once and makes
// symlink cycles harmless. Symlinks are counted separately from files.

// Binary sniffing: `binary-resources` counts regular files that are not Mach-O
// and whose first 8 KiB contain a NUL byte. That approximates the isbinaryfile
// content heuristic osx-sign relies on to decide whether a non-Mach-O file is
// signed; it is not byte-identical to it (isbinaryfile also weighs UTF BOMs and
// byte scoring), so treat it as a close lower bound rather than an exact count.
// `.dylib` and `.node` files already have their own counters and are excluded
// here so they are never counted twice.
//
// Thresholds (overridable so tests and unusually large bundles do not have to
// create thousands of files):
//   PI_DESKTOP_INVENTORY_MAX_FILES       default 2000   (whole bundle)
//   PI_DESKTOP_INVENTORY_MAX_DIR_FILES   default 500    (single directory)
//
// Exit status: 0 for a completed inventory, 1 for a bad path or bad usage.
// Warnings never change the exit status.

import fs from "node:fs";
import path from "node:path";

const USAGE =
  "usage: node scripts/macos-bundle-inventory.mjs <path> [--json] [--top <n>]";

const DEFAULT_TOP = 5;
const MAX_LISTED_WARNINGS = 10;

const RESOURCE_DIRECTORIES = [
  "agent-runtime",
  "plugins",
  "skills",
  "models.dev",
  "bin",
];

// Magic numbers of a Mach-O header, read as a big-endian uint32:
// 32/64-bit big-endian, 32/64-bit little-endian, fat and fat64 big-endian, and
// the byte-reversed (little-endian) fat variants.
const MACH_O_MAGICS = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xcafebabf,
  0xbebafeca, 0xbfbafeca,
]);

// How many leading bytes are sampled when deciding whether a non-Mach-O file
// merely looks binary.
const BINARY_SNIFF_BYTES = 8192;

// Extensions that already have a dedicated counter above, and therefore must
// not be counted again as `binary-resources`.
const EXTENSION_COUNTED_BINARIES = [".dylib", ".node"];

// Locations where a Mach-O file is expected. Anything else is reported, because
// it either bloats signing or hides a binary that should not ship.
const EXPECTED_MACH_O_PREFIXES = [
  "Contents/MacOS/",
  "Contents/Frameworks/",
  "Contents/Resources/bin/",
];

const warnings = [];

function emitWarning(message) {
  warnings.push(message);
}

function flushWarnings() {
  for (const message of warnings) {
    process.stdout.write(`warning: ${message}\n`);
  }
}

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArguments(argv) {
  let target = null;
  let json = false;
  let top = DEFAULT_TOP;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      json = true;
    } else if (argument === "--top") {
      const value = argv[index + 1];
      if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) {
        fail(`--top requires a positive integer (${USAGE})`);
      }
      top = Number(value);
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (argument.startsWith("-") && argument !== "-") {
      fail(`unknown option: ${argument} (${USAGE})`);
    } else if (target === null) {
      target = argument;
    } else {
      fail(`unexpected argument: ${argument} (${USAGE})`);
    }
  }

  if (target === null) {
    fail(USAGE);
  }
  return { target, json, top };
}

/**
 * Read a file's leading bytes once and classify it. The first four bytes decide
 * Mach-O membership; for everything else the first 8 KiB decide whether the file
 * merely looks binary, which is what makes osx-sign sign it (see the header).
 * Unreadable files classify as neither, and are reported by the walker instead.
 */
function sniffFile(absolutePath) {
  let descriptor;
  try {
    descriptor = fs.openSync(absolutePath, "r");
    const header = Buffer.alloc(4);
    if (
      fs.readSync(descriptor, header, 0, 4, 0) === 4 &&
      MACH_O_MAGICS.has(header.readUInt32BE(0))
    ) {
      return { machO: true, binary: true };
    }
    const sample = Buffer.alloc(BINARY_SNIFF_BYTES);
    const read = fs.readSync(descriptor, sample, 0, BINARY_SNIFF_BYTES, 0);
    return { machO: false, binary: sample.subarray(0, read).includes(0) };
  } catch {
    return { machO: false, binary: false };
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The file is only sniffed; a close failure changes nothing.
      }
    }
  }
}

/** True for extensions that already have a dedicated counter. */
function isCountedByExtension(name) {
  return EXTENSION_COUNTED_BINARIES.some((extension) =>
    name.endsWith(extension),
  );
}

function isDirectory(absolutePath) {
  try {
    return fs.statSync(absolutePath).isDirectory();
  } catch {
    return false;
  }
}

function directoriesIn(absoluteDirectory) {
  let names;
  try {
    names = fs.readdirSync(absoluteDirectory);
  } catch {
    return [];
  }
  const result = [];
  for (const name of names) {
    const candidate = path.join(absoluteDirectory, name);
    if (isDirectory(candidate)) {
      result.push(candidate);
    }
  }
  return result;
}

function appBundlesIn(absoluteDirectory) {
  return directoriesIn(absoluteDirectory).filter((candidate) =>
    candidate.endsWith(".app"),
  );
}

/**
 * Resolve the single `.app` bundle to inspect. A release directory holds it one
 * level down (`release/mac-arm64/PI-Desktop.app`); a build directory may hold it
 * directly, so both levels are searched. Anything other than exactly one match
 * fails: silently inventorying the wrong bundle is worse than not running.
 */
function resolveBundle(target) {
  const resolved = path.resolve(target);
  let stats;
  try {
    stats = fs.statSync(resolved);
  } catch {
    fail(`path does not exist: ${resolved}`);
  }
  if (!stats.isDirectory()) {
    fail(`not a directory: ${resolved}`);
  }
  if (path.basename(resolved).endsWith(".app")) {
    return resolved;
  }

  const candidates = [...appBundlesIn(resolved)];
  for (const directory of directoriesIn(resolved)) {
    candidates.push(...appBundlesIn(directory));
  }
  if (candidates.length !== 1) {
    fail(
      `expected exactly one *.app bundle under ${resolved} (found ${candidates.length})`,
    );
  }
  return candidates[0];
}

/**
 * Walk the bundle once. Directory symlinks are not followed (see the header),
 * so a symlink cycle cannot loop or double count.
 */
function walkBundle(root) {
  const files = [];
  const directories = [];
  const symlinks = [];
  const pending = [{ absolute: root, relative: "" }];

  while (pending.length > 0) {
    const current = pending.pop();
    let names;
    try {
      names = fs.readdirSync(current.absolute);
    } catch (error) {
      emitWarning(
        `cannot read directory ${current.relative || "<bundle root>"}: ${error.code ?? error.message}`,
      );
      continue;
    }

    for (const name of names) {
      const absolute = path.join(current.absolute, name);
      const relative =
        current.relative === "" ? name : `${current.relative}/${name}`;
      let stats;
      try {
        stats = fs.lstatSync(absolute);
      } catch (error) {
        emitWarning(`cannot stat ${relative}: ${error.code ?? error.message}`);
        continue;
      }

      if (stats.isSymbolicLink()) {
        symlinks.push({ absolute, relative });
      } else if (stats.isDirectory()) {
        directories.push({ absolute, relative, name });
        pending.push({ absolute, relative });
      } else {
        const sniffed = stats.isFile()
          ? sniffFile(absolute)
          : { machO: false, binary: false };
        files.push({
          absolute,
          relative,
          name,
          bytes: stats.size,
          mode: stats.mode,
          machO: sniffed.machO,
          binary: sniffed.binary,
        });
      }
    }
  }

  return { files, directories, symlinks };
}

/** Directory part of a file's path, relative to the bundle root. */
function directorySegments(relative) {
  const segments = relative.split("/");
  segments.pop();
  return segments;
}

function isInsideFramework(relative) {
  return directorySegments(relative).some((segment) =>
    segment.endsWith(".framework"),
  );
}

function isInsideNestedApp(relative) {
  return directorySegments(relative).some((segment) =>
    segment.endsWith(".app"),
  );
}

function hasExpectedMachOLocation(relative) {
  if (EXPECTED_MACH_O_PREFIXES.some((prefix) => relative.startsWith(prefix))) {
    return true;
  }
  // A nested bundle owns its own layout, so anything inside it is expected.
  return isInsideNestedApp(relative);
}

/** `{ files, bytes }` for one resource directory, or `null` when it is absent. */
function summarizeResourceDirectory(appDirectory, files, name) {
  const absolute = path.join(appDirectory, "Contents", "Resources", name);
  if (!isDirectory(absolute)) {
    return null;
  }
  const prefix = `Contents/Resources/${name}/`;
  let count = 0;
  let bytes = 0;
  for (const file of files) {
    if (file.relative.startsWith(prefix)) {
      count += 1;
      bytes += file.bytes;
    }
  }
  return { files: count, bytes };
}

/** Sum of `st_size` per direct child directory of `Contents`, largest first. */
function summarizeTopLevelCost(files) {
  const cost = new Map();
  for (const file of files) {
    const segments = file.relative.split("/");
    if (segments[0] !== "Contents" || segments.length < 3) {
      continue;
    }
    const key = `Contents/${segments[1]}`;
    cost.set(key, (cost.get(key) ?? 0) + file.bytes);
  }
  return [...cost.entries()]
    .map(([entryPath, bytes]) => ({ path: entryPath, bytes }))
    .sort((left, right) => right.bytes - left.bytes || left.path.localeCompare(right.path));
}

function reportCrowdedDirectories(files, maxDirectoryFiles) {
  const filesPerDirectory = new Map();
  for (const file of files) {
    const directory = directorySegments(file.relative).join("/");
    filesPerDirectory.set(
      directory,
      (filesPerDirectory.get(directory) ?? 0) + 1,
    );
  }
  const crowded = [...filesPerDirectory.entries()]
    .filter(([, count]) => count > maxDirectoryFiles)
    .sort((left, right) => right[1] - left[1]);
  reportCapped(
    `directory holds more than ${maxDirectoryFiles} files`,
    crowded.map(
      ([directory, count]) => `${directory || "<bundle root>"} (${count} files)`,
    ),
  );
}

function reportCapped(headline, items) {
  for (const item of items.slice(0, MAX_LISTED_WARNINGS)) {
    emitWarning(`${headline}: ${item}`);
  }
  if (items.length > MAX_LISTED_WARNINGS) {
    emitWarning(
      `${headline}: ${items.length - MAX_LISTED_WARNINGS} more not listed`,
    );
  }
}

function formatResourceSummary(summary) {
  return RESOURCE_DIRECTORIES.map((name) => {
    const entry = summary[name];
    return entry === null ? `${name}=<missing>` : `${name}=${entry.files}/${entry.bytes}`;
  }).join(", ");
}

function run() {
  const { target, json, top } = parseArguments(process.argv.slice(2));
  const bundle = resolveBundle(target);
  const maxFiles = positiveInteger(
    process.env.PI_DESKTOP_INVENTORY_MAX_FILES,
    2000,
  );
  const maxDirectoryFiles = positiveInteger(
    process.env.PI_DESKTOP_INVENTORY_MAX_DIR_FILES,
    500,
  );

  const { files, directories, symlinks } = walkBundle(bundle);

  const machOFiles = files.filter((file) => file.machO);
  const dylib = files.filter((file) => file.name.endsWith(".dylib")).length;
  const nodeModules = files.filter((file) => file.name.endsWith(".node")).length;
  const frameworks = directories.filter((directory) =>
    directory.name.endsWith(".framework"),
  ).length;
  const nestedApps = directories.filter((directory) =>
    directory.name.endsWith(".app"),
  ).length;
  const frameworkBinaries = machOFiles.filter((file) =>
    isInsideFramework(file.relative),
  ).length;
  // Resource files that are not Mach-O but look binary, so osx-sign gives each
  // of them its own `codesign` call. `.dylib`/`.node` are excluded: they are
  // already reported by their own counters.
  const binaryResources = files.filter(
    (file) => file.binary && !file.machO && !isCountedByExtension(file.name),
  ).length;
  const executableScripts = files.filter(
    (file) => !file.machO && (file.mode & 0o111) !== 0,
  ).length;
  const executableMachO = machOFiles.filter(
    (file) => (file.mode & 0o111) !== 0,
  ).length;
  // osx-sign signs every nested bundle and every file isbinaryfile calls binary:
  // the Mach-O files and the binary-looking resources alike.
  const signingCandidates = machOFiles.length + nestedApps + binaryResources;

  const resources = {};
  for (const name of RESOURCE_DIRECTORIES) {
    resources[name] = summarizeResourceDirectory(bundle, files, name);
  }
  const topLevelCost = summarizeTopLevelCost(files);
  const slowestLikely = [...machOFiles]
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, top)
    .map((file) => ({ path: file.relative, bytes: file.bytes }));

  if (files.length > maxFiles) {
    emitWarning(
      `bundle contains ${files.length} files (threshold ${maxFiles}); osx-sign inspects every entry.`,
    );
  }
  reportCrowdedDirectories(files, maxDirectoryFiles);
  reportCapped(
    "non-Mach-O regular file in Contents/Resources/bin",
    files
      .filter(
        (file) =>
          file.relative.startsWith("Contents/Resources/bin/") && !file.machO,
      )
      .map((file) => file.relative),
  );
  reportCapped(
    "Mach-O outside Contents/MacOS, Contents/Frameworks, Contents/Resources/bin or a nested .app",
    machOFiles
      .filter((file) => !hasExpectedMachOLocation(file.relative))
      .map((file) => file.relative),
  );

  process.stdout.write(
    `==> ${path.basename(bundle)} inventory: ${bundle}\n`,
  );
  process.stdout.write(
    `entries: ${files.length + directories.length + symlinks.length} (files: ${files.length}, directories: ${directories.length}, symlinks: ${symlinks.length})\n`,
  );
  process.stdout.write(
    `mach-o: ${machOFiles.length} (dylib: ${dylib}, node: ${nodeModules}, framework binaries: ${frameworkBinaries})\n`,
  );
  process.stdout.write(`binary-resources: ${binaryResources}\n`);
  process.stdout.write(
    `bundles: frameworks=${frameworks} nested-apps=${nestedApps}\n`,
  );
  process.stdout.write(
    `executables: script=${executableScripts} mach-o=${executableMachO}\n`,
  );
  process.stdout.write(`resources: ${formatResourceSummary(resources)}\n`);
  process.stdout.write(
    `top-level-cost: ${
      topLevelCost.length === 0
        ? "<none>"
        : topLevelCost
            .slice(0, top)
            .map((entry) => `${entry.path}=${entry.bytes}`)
            .join(", ")
    }\n`,
  );
  process.stdout.write(
    `signing-candidates: ${signingCandidates} (mach-o ${machOFiles.length} + nested-bundles ${nestedApps} + binary-resources ${binaryResources})\n`,
  );
  process.stdout.write(
    `slowest-likely: ${
      slowestLikely.length === 0
        ? "<none>"
        : slowestLikely
            .map((entry) => `${entry.path} (${entry.bytes} bytes)`)
            .join(", ")
    }\n`,
  );

  flushWarnings();

  if (json) {
    const payload = {
      bundle,
      bundleName: path.basename(bundle),
      entries: files.length + directories.length + symlinks.length,
      files: files.length,
      directories: directories.length,
      symlinks: symlinks.length,
      machO: machOFiles.length,
      binaryResources,
      dylib,
      nodeModules,
      frameworkBinaries,
      frameworks,
      nestedApps,
      executableScripts,
      executableMachO,
      machOOutsideFramework: machOFiles.length - frameworkBinaries,
      signingCandidates,
      resources,
      topLevelCost: topLevelCost.slice(0, top),
      slowestLikely,
      warnings,
    };
    process.stdout.write(`inventory-json: ${JSON.stringify(payload)}\n`);
  }
}

run();
