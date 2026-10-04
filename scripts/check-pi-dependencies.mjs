import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targetVersion = "1.0.1";
// Proof chain that pnpm installed the patched instance: the root lockfile's
// patchedDependencies section maps `name@version` to a 64-hex patch hash, and
// the virtual-store lockfile embeds that hash in the installed snapshot's
// `version: <v>(patch_hash=<hash>)` line. realpath-based matching cannot work
// on Windows, where pnpm shortens `.pnpm` directory names (long-path limit)
// and the literal `patch_hash=` segment disappears from resolved paths
// (#1361).
const rootLockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
const virtualStoreLockfile = readFileSync(join(root, "node_modules/.pnpm/lock.yaml"), "utf8");

function installedPatchHash(packageName) {
  const declared = rootLockfile.match(
    new RegExp(`'?${packageName.replace("/", "/")}@${targetVersion}'?:[ \\t]*([a-f0-9]{64})`),
  )?.[1];
  if (!declared) return undefined;
  return virtualStoreLockfile.includes(`(patch_hash=${declared}`)
    ? declared
    : undefined;
}

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
  if (patched && !installedPatchHash(expectedName)) {
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
  if (new RegExp(`@earendil-works/${packageName}@0\\.99\\.1(?:[(:]|$)`).test(lockfile)) {
    throw new Error(`pnpm-lock.yaml still contains @earendil-works/${packageName}@0.99.1`);
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
  "@earendil-works/chord@1.0.1",
  "@earendil-works/pi-agent-core@1.0.1",
  "@earendil-works/pi-ai@1.0.1",
  "@earendil-works/pi-codemode@1.0.1",
  "@earendil-works/pi-coding-agent@1.0.1",
  "@earendil-works/pi-mcp@1.0.1",
  "@earendil-works/pi-telemetry@1.0.1",
  "@earendil-works/pi-tui@1.0.1",
].sort();
if (JSON.stringify(actualReleaseAgeExclusions) !== JSON.stringify(expectedReleaseAgeExclusions)) {
  throw new Error("Pi minimumReleaseAgeExclude entries must match only the exact 1.0.1 release packages");
}

process.stdout.write(`Pi direct pins and installed package instances are aligned at ${targetVersion}.\n`);
