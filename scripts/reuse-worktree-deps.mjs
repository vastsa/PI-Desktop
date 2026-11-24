// Run from a fresh request worktree. Never install against this shared layout.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const root = realpathSync(git("rev-parse", "--show-toplevel"));
const common = cwd => realpathSync.native(git("-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"));
const primary = dirname(common(root));
if (realpathSync.native(root) === primary) throw new Error("Run inside a dedicated worktree, not the primary checkout.");
const main = process.argv[2] ? realpathSync.native(process.argv[2]) : primary;
if (common(main) !== common(root)) throw new Error("Dependency source must belong to the same repository.");
const installedLock = join(main, "node_modules/.pnpm/lock.yaml");
if (!existsSync(installedLock)) throw new Error("Dependency source needs a complete pnpm installation first.");

const manifests = ["package.json", "apps/*/package.json", "packages/*/package.json", "docs/package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", "patches"];
const installInputs = cwd => git("-C", cwd, "ls-files", "-z", "--", ...manifests).split("\0").filter(Boolean);
const inputs = installInputs(main);
const required = installInputs(root);
if (inputs.join("\n") !== required.join("\n")) throw new Error("Workspace manifests or patches differ; use an isolated install.");
for (const file of inputs) {
  if (!readFileSync(join(main, file)).equals(readFileSync(join(root, file)))) throw new Error(`Different ${file}; use an isolated install.`);
}
// pnpm 12 prepends a separate package-manager document to the wanted lock.
const projectLock = file => readFileSync(file, "utf8").replaceAll("\r\n", "\n").split(/^---$/m).at(-1).trim();
if (projectLock(installedLock) !== projectLock(join(root, "pnpm-lock.yaml"))) throw new Error("Installed dependencies are stale; choose a compatible source checkout.");
const packages = inputs.filter(path => /^(?:(?:apps|packages)\/[^/]+|docs)\/package\.json$/.test(path));
const workspace = new Map(packages.map(file => [JSON.parse(readFileSync(join(root, file), "utf8")).name, join(root, dirname(file))]));
const links = [];
const binDirs = [];
const directories = [];
for (const folder of [".", ...packages.map(dirname)]) {
  const source = join(main, folder, "node_modules");
  if (!existsSync(source)) continue;
  const dest = join(root, folder, "node_modules");
  if (lstatSync(dest, { throwIfNoEntry: false })) throw new Error(`Refusing to overwrite ${dest}. Use a fresh worktree.`);
  directories.push(dest);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && ![".pnpm", ".bin"].includes(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(dest, entry.name);
    if (entry.name === "@pi-desktop") {
      directories.push(to);
      for (const name of readdirSync(from)) {
        const target = workspace.get(`@pi-desktop/${name}`);
        if (!target) throw new Error(`Unknown workspace package @pi-desktop/${name}`);
        links.push([target, join(to, name)]);
      }
    } else if (entry.name === ".bin") {
      // pnpm can regenerate shims even during `exec`; never share writable bins.
      binDirs.push([from, to]);
    } else if (entry.isDirectory() || entry.isSymbolicLink()) {
      links.push([realpathSync(from), to]);
    }
  }
}
for (const dir of directories) mkdirSync(dir);
for (const [target, path] of links) symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
for (const [from, to] of binDirs) cpSync(realpathSync(from), to, { recursive: true, verbatimSymlinks: true });
console.log(`Linked ${links.length} dependency directories. Workspace packages resolve inside ${root}.`);
console.log("Build workspace packages here. Do not install, prune, or rebuild shared dependencies through these links.");
console.log("For pnpm run/exec, set pnpm_config_verify_deps_before_run=false to disable automatic installs.");
