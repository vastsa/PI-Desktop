#!/usr/bin/env node
/**
 * Release preflight: every version surface and release document must describe
 * the same app version before a stable tag is cut.
 *
 * Usage:
 *   node scripts/check-release-docs.mjs             # check against package.json
 *   node scripts/check-release-docs.mjs <version>   # check against an explicit version
 *
 * Checks (D260, docs/spec/06-delivery/06-release-runbook.md section 4.1):
 *   1. Workspace version surfaces agree: every workspace package.json,
 *      [workspace.package] in Cargo.toml, the host-core Cargo.lock entry, and
 *      APP_VERSION in packages/shared/src/protocol.ts.
 *   2. packages/shared/src/changelog.ts has an entry for the version under both
 *      `en` and `zh-CN`, newest-first, with matching highlight counts.
 *   3. packages/shared/src/changelog.test.ts pins the version as newest.
 *   4. README.md and README.zh-CN.md declare the current release line
 *      (`<major>.<minor>.x`) in their status section.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (relPath) => readFileSync(path.join(root, relPath), "utf8");
const failures = [];
const fail = (relPath, message) => failures.push(`${relPath}: ${message}`);

const requested = process.argv[2];
if (requested && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(requested)) {
  console.error("Usage: node scripts/check-release-docs.mjs [version]   e.g. 0.11.0");
  process.exit(1);
}

const version = requested ?? JSON.parse(read("package.json")).version;
const releaseLine = `${version.split(".").slice(0, 2).join(".")}.x`;

// 1. Version surfaces.
const packageFiles = ["package.json", "docs/package.json"];
for (const group of ["apps", "packages"]) {
  for (const dir of readdirSync(path.join(root, group), { withFileTypes: true })) {
    const relPath = path.join(group, dir.name, "package.json");
    if (dir.isDirectory() && existsSync(path.join(root, relPath))) packageFiles.push(relPath);
  }
}
for (const relPath of packageFiles) {
  const found = JSON.parse(read(relPath)).version;
  if (found !== version) fail(relPath, `version is ${found}, expected ${version}`);
}

for (const [relPath, pattern, label] of [
  ["Cargo.toml", /\[workspace\.package\][\s\S]*?\bversion = "([^"]+)"/, "[workspace.package] version"],
  ["Cargo.lock", /name = "host-core"\nversion = "([^"]+)"/, "host-core version"],
  ["packages/shared/src/protocol.ts", /export const APP_VERSION = "([^"]+)"/, "APP_VERSION"],
]) {
  const found = read(relPath).match(pattern)?.[1];
  if (found !== version) fail(relPath, `${label} is ${found ?? "missing"}, expected ${version}`);
}

// 2. Bundled models.dev snapshot.
const modelsDevCatalogPath = "apps/desktop/resources/models.dev/api.json";
try {
  const catalog = JSON.parse(read(modelsDevCatalogPath));
  if (
    !catalog ||
    Array.isArray(catalog) ||
    typeof catalog !== "object" ||
    !Object.values(catalog).some(
      (provider) => provider && typeof provider === "object" && provider.models,
    )
  ) {
    fail(modelsDevCatalogPath, "contains no provider model records");
  }
} catch (error) {
  fail(modelsDevCatalogPath, `could not parse bundled catalog: ${error.message}`);
}

// 3. Dual-locale in-app changelog. Import the real catalog rather than parsing
// it: Node strips the TypeScript types, so wrapped or concatenated highlight
// strings are counted as the app sees them.
let catalogs = null;
try {
  ({ CHANGELOG: catalogs } = await import(
    new URL("../packages/shared/src/changelog.ts", import.meta.url)
  ));
} catch (error) {
  fail("packages/shared/src/changelog.ts", `could not be imported: ${error.message}`);
}

if (catalogs) {
  for (const locale of ["en", "zh-CN"]) {
    const entries = catalogs[locale];
    if (!entries?.length) {
      fail("packages/shared/src/changelog.ts", `the ${locale} catalog is empty`);
      continue;
    }
    if (!entries.some((entry) => entry.version === version)) {
      fail("packages/shared/src/changelog.ts", `${locale} has no entry for ${version}`);
      continue;
    }
    if (entries[0].version !== version) {
      fail(
        "packages/shared/src/changelog.ts",
        `${locale} lists ${entries[0].version} first; ${version} must be newest-first`,
      );
    }
  }

  const en = catalogs.en?.find((entry) => entry.version === version);
  const zh = catalogs["zh-CN"]?.find((entry) => entry.version === version);
  if (en && zh && en.highlights.length !== zh.highlights.length) {
    fail(
      "packages/shared/src/changelog.ts",
      `${version} has ${en.highlights.length} en highlights and ${zh.highlights.length} zh-CN highlights`,
    );
  }
}

// 3. Catalog test pins the newest version.
if (!read("packages/shared/src/changelog.test.ts").includes(`"${version}"`)) {
  fail("packages/shared/src/changelog.test.ts", `expected version list does not contain ${version}`);
}

// 4. READMEs declare the current release line.
for (const relPath of ["README.md", "README.zh-CN.md"]) {
  if (!read(relPath).includes(releaseLine)) {
    fail(relPath, `status section does not mention the ${releaseLine} release line`);
  }
}

if (failures.length > 0) {
  console.error(`Release documentation is not aligned with ${version}:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error("\nSee docs/spec/06-delivery/06-release-runbook.md section 4.1.");
  process.exit(1);
}
console.log(`Release documentation is aligned with ${version} (${releaseLine} line).`);
