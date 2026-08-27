#!/usr/bin/env node
/**
 * Bump the workspace version everywhere and (optionally) create the release tag.
 *
 * Usage:
 *   node scripts/release.mjs <version>          # bump files only
 *   node scripts/release.mjs <version> --tag    # bump + commit (only bumped files) + tag v<version>
 *
 * BEFORE running this for a stable release, update every version-bearing
 * document (D164 + D200, docs/spec/06-delivery/06-release-runbook.md section 4.1):
 *   - packages/shared/src/changelog.ts (EN + zh-CN entries for <version>,
 *     matching highlight counts) and its newest-first list in changelog.test.ts
 *   - the release line stated in README.md and README.zh-CN.md
 * GitHub auto-generated release bodies are web-only and are not a substitute.
 *
 * This script runs `scripts/check-release-docs.mjs <version>` after bumping and
 * refuses to tag while any surface disagrees. Use --skip-docs-check only for a
 * deliberate non-release bump.
 *
 * Pushing the tag triggers .github/workflows/release.yml, which builds the
 * macOS / Windows / Linux installers and publishes them to a GitHub Release:
 *
 *   git push origin <branch> v<version>
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const version = process.argv[2];
const doTag = process.argv.includes("--tag");
const skipDocsCheck = process.argv.includes("--skip-docs-check");

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(version)) {
  console.error(
    "Usage: node scripts/release.mjs <version> [--tag] [--skip-docs-check]   e.g. 0.11.0 or 0.11.0-beta.1",
  );
  process.exit(1);
}

const changed = [];

function bumpPackageJson(relPath) {
  const file = path.join(root, relPath);
  if (!existsSync(file)) return;
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  if (pkg.version === version) return;
  pkg.version = version;
  writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  changed.push(relPath);
}

bumpPackageJson("package.json");
// `docs` is a third workspace root (pnpm-workspace.yaml), not under apps/packages.
bumpPackageJson("docs/package.json");
for (const group of ["apps", "packages"]) {
  for (const dir of readdirSync(path.join(root, group), { withFileTypes: true })) {
    if (dir.isDirectory()) bumpPackageJson(path.join(group, dir.name, "package.json"));
  }
}

// Cargo workspace version ([workspace.package] in root Cargo.toml), lockfile
// entry, and the APP_VERSION constant surfaced in the About panel.
for (const [relPath, pattern] of [
  ["Cargo.toml", /(\[workspace\.package\][\s\S]*?\bversion = ")[^"]+(")/],
  ["Cargo.lock", /(name = "host-core"\nversion = ")[^"]+(")/],
  ["packages/shared/src/protocol.ts", /(export const APP_VERSION = ")[^"]+(")/],
]) {
  const file = path.join(root, relPath);
  const source = readFileSync(file, "utf8");
  const updated = source.replace(pattern, `$1${version}$2`);
  if (updated === source) continue;
  writeFileSync(file, updated);
  changed.push(relPath);
}

if (changed.length === 0) {
  console.log(`Everything is already at ${version}; nothing to do.`);
} else {
  console.log(`Bumped to ${version}:\n  ${changed.join("\n  ")}`);
}

// Version surfaces, the dual-locale changelog, and the README release line must
// agree before a tag exists (D200). Bumping files is reversible; a tag is not.
if (!skipDocsCheck) {
  try {
    execFileSync(process.execPath, [path.join(root, "scripts/check-release-docs.mjs"), version], {
      cwd: root,
      stdio: "inherit",
    });
  } catch {
    console.error("\nRelease documentation check failed; not committing or tagging.");
    process.exit(1);
  }
}

if (changed.length === 0) process.exit(0);

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const tag = `v${version}`;
const branch = git("rev-parse", "--abbrev-ref", "HEAD");

if (doTag) {
  if (git("tag", "--list", tag)) {
    console.error(`Tag ${tag} already exists.`);
    process.exit(1);
  }
  // Pathspec commit: only the bumped files, so unrelated staged work stays untouched.
  git("commit", "-m", `chore(release): ${tag}`, "--", ...changed);
  git("tag", tag);
  console.log(`\nCommitted and tagged ${tag}. Publish with:\n  git push origin ${branch} ${tag}`);
} else {
  console.log(`\nNext steps:\n  git commit -m "chore(release): ${tag}" -- ${changed.join(" ")}\n  git tag ${tag}\n  git push origin ${branch} ${tag}`);
}
