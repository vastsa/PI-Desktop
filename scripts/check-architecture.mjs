#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

const root = process.cwd();
const sourceRoots = ["apps", "packages", "crates", "scripts"];
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx", ".rs"]);
const excludedSegments = new Set([
  ".git",
  "node_modules",
  "dist",
  "out",
  "release",
  "target",
  "coverage",
]);

const limits = {
  mainIndex: {
    path: "apps/desktop/electron/main/index.ts",
    max: 1_500,
  },
  appStore: {
    path: "apps/desktop/src/stores/app-store.ts",
    max: 1_000,
  },
  newTypeScript: {
    extension: ".ts/.tsx",
    max: 800,
  },
  rust: {
    extension: ".rs",
    max: 1_000,
  },
};

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

function isSourcePath(filePath) {
  const segments = filePath.split("/");
  if (
    segments.some((segment) => excludedSegments.has(segment)) ||
    !sourceRoots.some(
      (sourceRoot) => filePath === sourceRoot || filePath.startsWith(sourceRoot + "/"),
    )
  ) {
    return false;
  }
  return sourceExtensions.has(extname(filePath));
}

function trackedSourceFiles() {
  return git(["ls-files", "-co", "--exclude-standard"])
    .split("\n")
    .filter(Boolean)
    .filter(isSourcePath);
}

function locFor(filePath) {
  const text = readFileSync(resolve(root, filePath), "utf8");
  const newlineCount = (text.match(/\n/g) || []).length;
  return newlineCount + (text.length > 0 && !text.endsWith("\n") ? 1 : 0);
}

function collectMetrics(filePaths) {
  return filePaths
    .map((path) => ({ path, loc: locFor(path) }))
    .sort((left, right) => right.loc - left.loc || left.path.localeCompare(right.path));
}

function parseArgs() {
  const args = process.argv.slice(2);
  let base = process.env.ARCHITECTURE_BASE || "main";
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--base") {
      base = args[index + 1];
      index += 1;
    }
  }
  return { base };
}

function revisionExists(revision) {
  try {
    git(["rev-parse", "--verify", revision]);
    return true;
  } catch {
    return false;
  }
}

function fallbackBase() {
  try {
    return git(["rev-parse", "HEAD^"]);
  } catch {
    return null;
  }
}

function addedSourceFiles(base) {
  if (!base) return [];
  return git(["diff", "--name-only", "--diff-filter=A", base + "...HEAD"])
    .split("\n")
    .filter(Boolean)
    .filter(isSourcePath);
}

function readAllowlist() {
  const path = resolve(root, "docs/architecture/allowlist.json");
  if (!existsSync(path)) return { typescript: {}, rust: {} };
  const value = JSON.parse(readFileSync(path, "utf8"));
  return {
    typescript: value.typescript || {},
    rust: value.rust || {},
  };
}

function allowlistReason(entries, path) {
  const value = entries[path];
  if (typeof value === "string") return value;
  if (value && typeof value.reason === "string") return value.reason;
  return null;
}

function formatEntry(entry) {
  return entry.path + " (" + entry.loc + " LOC)";
}

const { base: requestedBase } = parseArgs();
const base = revisionExists(requestedBase) ? requestedBase : fallbackBase();
if (requestedBase && requestedBase !== base) {
  console.warn(
    "Architecture base " +
      requestedBase +
      " is unavailable; comparing added files with " +
      (base || "no base") +
      ".",
  );
}

const metrics = collectMetrics(trackedSourceFiles());
const byPath = new Map(metrics.map((entry) => [entry.path, entry]));
const allowlist = readAllowlist();
const failures = [];

const counts = new Map([
  [">500", metrics.filter((entry) => entry.loc > 500).length],
  [">1000", metrics.filter((entry) => entry.loc > 1_000).length],
  [">2000", metrics.filter((entry) => entry.loc > 2_000).length],
]);

for (const { path, max } of [limits.mainIndex, limits.appStore]) {
  const entry = byPath.get(path);
  if (!entry) {
    failures.push(path + " is missing");
  } else if (entry.loc > max) {
    failures.push(path + " is " + entry.loc + " LOC; maximum is " + max);
  }
}

const largeRust = metrics.filter(
  (entry) => extname(entry.path) === ".rs" && entry.loc > limits.rust.max,
);
for (const entry of largeRust) {
  if (!allowlistReason(allowlist.rust, entry.path)) {
    failures.push(
      formatEntry(entry) +
        " exceeds the Rust limit; add a documented entry to docs/architecture/allowlist.json",
    );
  }
}

const addedFiles = addedSourceFiles(base);
const largeNewTypeScript = addedFiles
  .map((path) => byPath.get(path))
  .filter(
    (entry) =>
      entry &&
      [".ts", ".tsx"].includes(extname(entry.path)) &&
      entry.loc > limits.newTypeScript.max &&
      !entry.path.endsWith(".d.ts"),
  );
for (const entry of largeNewTypeScript) {
  if (!allowlistReason(allowlist.typescript, entry.path)) {
    failures.push(
      formatEntry(entry) +
        " is a new TypeScript source file over " +
        limits.newTypeScript.max +
        " LOC; add a documented entry to docs/architecture/allowlist.json",
    );
  }
}

console.log("Architecture metrics");
console.log("Source files: " + metrics.length);
console.log("Total LOC: " + metrics.reduce((total, entry) => total + entry.loc, 0));
console.log("");
console.log("Largest 30 source files");
for (const entry of metrics.slice(0, 30)) {
  console.log("  " + formatEntry(entry));
}
console.log("");
console.log("LOC thresholds");
for (const threshold of [">500", ">1000", ">2000"]) {
  console.log("  " + threshold + ": " + counts.get(threshold));
}
console.log("");
console.log("Enforced limits");
console.log(
  "  " +
    limits.mainIndex.path +
    ": " +
    byPath.get(limits.mainIndex.path)?.loc +
    " / " +
    limits.mainIndex.max,
);
console.log(
  "  " +
    limits.appStore.path +
    ": " +
    byPath.get(limits.appStore.path)?.loc +
    " / " +
    limits.appStore.max,
);
console.log("  New TS/TSX limit: " + limits.newTypeScript.max + " LOC");
console.log("  Rust limit: " + limits.rust.max + " LOC");
console.log(
  "  Rust exemptions: " +
    largeRust.filter((entry) => allowlistReason(allowlist.rust, entry.path)).length,
);
console.log(
  "  New TS/TSX files checked: " +
    (base ? addedFiles.length : "skipped; no usable base"),
);

if (largeNewTypeScript.length > 0) {
  console.log("");
  console.log("New large TS/TSX files");
  for (const entry of largeNewTypeScript) console.log("  " + formatEntry(entry));
}

if (failures.length > 0) {
  console.error("");
  console.error("Architecture check failed");
  for (const failure of failures) console.error("  " + failure);
  process.exitCode = 1;
} else {
  console.log("");
  console.log("Architecture check passed");
}
