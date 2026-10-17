#!/usr/bin/env node
/**
 * Require every pinned Pi package to be installed at the target version, and
 * the ones we patch to be installed as pnpm's patched instance.
 *
 * Usage:
 *   node scripts/check-pi-dependencies.mjs
 *   node scripts/check-pi-dependencies.mjs --root <dir>
 *   pnpm check:pi-dependencies
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installedPatchHashes } from "./pi-patch-hash.mjs";

function parseArgs(argv) {
  let out = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root" && argv[i + 1]) {
      out = resolve(argv[i + 1]);
      i += 1;
    }
  }
  return out;
}

const root = parseArgs(process.argv.slice(2));
const targetVersion = "1.1.0";

function readJson(path) {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

function assertPin(manifestPath, section, packageName) {
  const manifest = readJson(manifestPath);
  const value = manifest[section]?.[packageName];
  if (value !== targetVersion) {
    throw new Error(`${manifestPath} ${section}.${packageName} must be exactly ${targetVersion}; found ${value ?? "missing"}`);
  }
}

function assertInstalled(packagePath, expectedName, { patched = false } = {}) {
  const link = join(root, packagePath);
  if (!existsSync(link)) throw new Error(`Install dependencies before this check; missing ${packagePath}`);
  const resolved = realpathSync(link);
  const manifest = JSON.parse(readFileSync(join(resolved, "package.json"), "utf8"));
  if (manifest.name !== expectedName || manifest.version !== targetVersion) {
    throw new Error(`${packagePath} resolves to ${manifest.name}@${manifest.version}, expected ${expectedName}@${targetVersion}`);
  }
  if (patched && installedPatchHashes(root, expectedName, targetVersion).length === 0) {
    throw new Error(`${packagePath} does not resolve to pnpm's patched package instance`);
  }
}

for (const packageName of [
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
]) {
  assertPin("packages/agent-runtime/package.json", "dependencies", packageName);
  assertInstalled(`packages/agent-runtime/node_modules/${packageName}`, packageName, { patched: true });
}
for (const packageName of ["@earendil-works/pi-ai", "@earendil-works/pi-mcp"]) {
  assertPin("apps/desktop/package.json", "devDependencies", packageName);
  assertInstalled(`apps/desktop/node_modules/${packageName}`, packageName, {
    patched: packageName === "@earendil-works/pi-ai",
  });
}

const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
for (const packageName of ["pi-agent-core", "pi-ai", "pi-coding-agent", "pi-mcp"]) {
  if (new RegExp(`@earendil-works/${packageName}@1\\.0\\.1(?:[(:]|$)`).test(lockfile)) {
    throw new Error(`pnpm-lock.yaml still contains @earendil-works/${packageName}@1.0.1`);
  }
}
const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
const releaseAgeExclusions = workspace.match(
  /^minimumReleaseAgeExclude:[ \t]*\r?\n((?:[ \t]+-[^\r\n]*\r?\n)*)/m,
)?.[1] ?? "";
const actualReleaseAgeExclusions = [...releaseAgeExclusions.matchAll(/^[ \t]+-[ \t]*['"]?([^'"\s]+)['"]?[ \t]*$/gm)]
  .map((match) => match[1])
  .sort();
const expectedReleaseAgeExclusions = [
  "@earendil-works/chord@1.1.0",
  "@earendil-works/pi-agent-core@1.1.0",
  "@earendil-works/pi-ai@1.1.0",
  "@earendil-works/pi-codemode@1.1.0",
  "@earendil-works/pi-coding-agent@1.1.0",
  "@earendil-works/pi-mcp@1.1.0",
  "@earendil-works/pi-telemetry@1.1.0",
  "@earendil-works/pi-tui@1.1.0",
].sort();
if (JSON.stringify(actualReleaseAgeExclusions) !== JSON.stringify(expectedReleaseAgeExclusions)) {
  throw new Error("Pi minimumReleaseAgeExclude entries must match only the exact 1.1.0 release packages");
}

process.stdout.write(`Pi direct pins and installed package instances are aligned at ${targetVersion}.\n`);
