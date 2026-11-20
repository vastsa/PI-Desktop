#!/usr/bin/env node
/**
 * Fail unless a packaged app.asar carries the expected `piDistribution`
 * marker in its package.json.
 *
 *   node scripts/check-packaged-distribution.mjs <app.asar> <expected>
 *
 * The marker reaches the package as an electron-builder command-line override
 * (`-c.extraMetadata.piDistribution=...`). electron-builder ignores an override
 * it does not parse, without an error, and the build stays green with the
 * static default. The release workflow therefore checks the artifact it just
 * built instead of trusting the command line: the updater reads this marker to
 * decide whether an in-app update may be attempted.
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The asar library electron-builder itself packages with. */
function loadAsar() {
  const fromDesktop = createRequire(join(root, "apps", "desktop", "package.json"));
  const fromBuilder = createRequire(fromDesktop.resolve("electron-builder/package.json"));
  const fromLib = createRequire(fromBuilder.resolve("app-builder-lib/package.json"));
  return fromLib("@electron/asar");
}

function fail(message) {
  console.error(`check-packaged-distribution: ${message}`);
  process.exit(1);
}

const [archive, expected] = process.argv.slice(2);
if (!archive || !expected) {
  fail("usage: check-packaged-distribution.mjs <app.asar> <expected>");
}

let metadata;
try {
  metadata = JSON.parse(loadAsar().extractFile(resolve(archive), "package.json").toString("utf8"));
} catch (error) {
  fail(`cannot read package.json from ${archive}: ${error instanceof Error ? error.message : String(error)}`);
}

const actual = metadata?.piDistribution;
if (actual !== expected) {
  fail(`expected piDistribution ${JSON.stringify(expected)} but the package carries ${JSON.stringify(actual)}`);
}
console.log(`piDistribution is ${JSON.stringify(actual)} in ${archive}`);
