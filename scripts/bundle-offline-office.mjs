import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, lstat, mkdtemp, readdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

const plugin = new URL("../apps/desktop/resources/offline-office/", import.meta.url);
const ARM64 = 3; // electron-builder's Arch.arm64 in the afterPack context.

async function verifyRuntimeLinks(runtime) {
  if (!(await lstat(runtime)).isDirectory()) {
    throw new Error("Office Runtime link or non-directory cannot be the package root.");
  }
  const root = await realpath(runtime);
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    const link = join(entry.parentPath, entry.name);
    const name = relative(root, link);
    if (isAbsolute(await readlink(link))) throw new Error(`Office Runtime link must be relative: ${name}`);
    const target = await realpath(link).catch((cause) => {
      throw new Error(`Office Runtime link cannot be resolved: ${name}`, { cause });
    });
    const targetPath = relative(root, target);
    if (targetPath === ".." || targetPath.startsWith(`..${sep}`) || isAbsolute(targetPath)) {
      throw new Error(`Office Runtime link points outside the package: ${name}`);
    }
  }
}

export async function verifyOfflineOfficeRuntime(runtime) {
  await verifyRuntimeLinks(runtime);
  for (const interpreter of ["node/bin/node", "python/bin/python3.12"]) {
    await access(join(runtime, interpreter), constants.X_OK);
  }
  const { packages } = JSON.parse(await readFile(join(runtime, "metadata/package-lock.json"), "utf8"));
  if (packages?.["node_modules/docx"]?.version !== "9.16.0") {
    throw new Error("Expected docx 9.16.0 in the Office Runtime lockfile.");
  }
  for (const [relative, locked] of Object.entries(packages)) {
    if (relative === "") continue;
    if (!relative.startsWith("node_modules/") || relative.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`Invalid Office Runtime package path: ${relative}`);
    }
    const installed = JSON.parse(await readFile(join(runtime, "node/lib", relative, "package.json"), "utf8"));
    if (installed.version !== locked.version) throw new Error(`Office Runtime version mismatch: ${relative}`);
  }
  for (const module of ["lxml", "docx"]) {
    await access(join(runtime, "python/lib/python3.12/site-packages", module, "__init__.py"));
  }
  await access(join(runtime, "metadata/runtime-source.json"));
}

export async function smokeTestOfflineOffice(resources) {
  const launcher = join(resources, "plugins", "pie.offline-office", "word", "word.sh");
  const workspace = await mkdtemp(join(tmpdir(), "pie-office-smoke-"));
  const text = "离线办公验证";
  const output = "Word smoke.docx";
  const run = (args, input) => execFileSync("/bin/sh", [launcher, ...args], {
    cwd: workspace, encoding: "utf8", input, stdio: "pipe", timeout: 30_000,
  });
  try {
    run(["create", output, ""], text + "\n");
    if (run(["extract", output]) !== text + "\n") throw new Error("Unexpected DOCX readback.");
  } catch (error) {
    throw new Error(`Office Word package smoke test failed: ${error.message}`, { cause: error });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export default async function bundleOfflineOffice({ electronPlatformName, arch, appOutDir, targets }) {
  if (electronPlatformName !== "linux" || arch !== ARM64 || !targets.some((target) => target.name === "deb")) return;
  const runtime = process.env.PI_CODE_OFFICE_RUNTIME_DIR;
  if (!runtime) return;
  if (targets.length !== 1) throw new Error("Build the Offline Office Debian candidate with dist:kylin.");
  if (!isAbsolute(runtime)) {
    throw new Error("Set PI_CODE_OFFICE_RUNTIME_DIR to the absolute path of the staged ARM64 Office Runtime.");
  }
  await verifyOfflineOfficeRuntime(runtime);
  const resources = join(appOutDir, "resources");
  await cp(runtime, join(resources, "office-runtime"), { recursive: true, verbatimSymlinks: true });
  await cp(plugin, join(resources, "plugins", "pie.offline-office"), { recursive: true });
}
