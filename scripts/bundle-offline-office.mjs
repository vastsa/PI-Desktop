import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, lstat, mkdtemp, readdir, readFile, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

const plugin = new URL("../apps/desktop/resources/offline-office/", import.meta.url);
const ARM64 = 3; // electron-builder's Arch.arm64 in the afterPack context.

async function verifyRuntimeLinks(runtime, label) {
  if (!(await lstat(runtime)).isDirectory()) {
    throw new Error(`${label} link or non-directory cannot be the package root.`);
  }
  const root = await realpath(runtime);
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    const link = join(entry.parentPath, entry.name);
    const name = relative(root, link);
    if (isAbsolute(await readlink(link))) throw new Error(`${label} link must be relative: ${name}`);
    const target = await realpath(link).catch((cause) => {
      throw new Error(`${label} link cannot be resolved: ${name}`, { cause });
    });
    const targetPath = relative(root, target);
    if (targetPath === ".." || targetPath.startsWith(`..${sep}`) || isAbsolute(targetPath)) {
      throw new Error(`${label} link points outside the package: ${name}`);
    }
  }
}

export async function verifyOfflineOfficeRuntime(runtime) {
  await verifyRuntimeLinks(runtime, "Office Runtime");
  for (const executable of ["node/bin/node", "python/bin/python3.12", "libreoffice/program/soffice", "libreoffice/program/soffice.bin"]) {
    await access(join(runtime, executable), constants.X_OK);
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
  const site = join(runtime, "python/lib/python3.12/site-packages");
  for (const module of ["lxml", "docx", "openpyxl", "pandas", "numpy", "dateutil", "pptx", "PIL", "xlsxwriter"]) {
    await access(join(site, module, "__init__.py"));
  }
  await access(join(site, "six.py"));
  for (const [name, version] of [["pandas", "3.1.1"], ["python_dateutil", "2.9.0.post0"]]) {
    const metadata = await readFile(join(site, `${name}-${version}.dist-info`, "METADATA"), "utf8").catch((cause) => {
      throw new Error(`Expected ${name} ${version} in the Office Runtime.`, { cause });
    });
    if (!metadata.split(/\r?\n/).includes(`Version: ${version}`)) {
      throw new Error(`Expected ${name} ${version} in the Office Runtime.`);
    }
  }
  await access(join(runtime, "metadata/runtime-source.json"));
}

export async function verifyOfflineWxRuntime(runtime) {
  await verifyRuntimeLinks(runtime, "WX offline package");
  if ((await readFile(join(runtime, "VERSION"), "utf8")).trim() !== "0.21.3" ||
      (await readFile(join(runtime, "OFFLINE_PACKAGE"), "utf8")).trim() !== "version=0.21.3\nplatform=linux-arm64") {
    throw new Error("Expected the WX 0.21.3 Linux ARM64 offline package.");
  }
  const manifest = JSON.parse(await readFile(join(runtime, "wheelhouse/manifest.json"), "utf8"));
  if (manifest.platform !== "linux-arm64" || !manifest.environments?.cp312?.length) {
    throw new Error("The WX offline wheelhouse must support bundled Linux ARM64 Python 3.12.");
  }
  for (const file of ["scripts/offline_install.py", "scripts/main.py", "assets/wx_template.docx", "wheelhouse/wheels.tar.xz"]) {
    await access(join(runtime, file), constants.R_OK);
  }
}

export async function smokeTestOfflineOffice(resources) {
  const workspace = await mkdtemp(join(tmpdir(), "pie-office-smoke-"));
  const text = "离线办公验证";
  const output = "Word smoke.docx";
  const run = (skill, args, input) => execFileSync("/bin/sh", [
    join(resources, "plugins", "pie.offline-office", skill, `${skill}.sh`), ...args,
  ], {
    cwd: workspace, encoding: "utf8", input, stdio: "pipe", timeout: 30_000,
    env: { ...process.env, PI_DESKTOP_DATA_DIR: workspace },
  });
  let skill = "Word";
  try {
    run("word", ["create", output, ""], text + "\n");
    if (run("word", ["extract", output]) !== text + "\n") throw new Error("Unexpected DOCX readback.");
    skill = "Excel";
    const excel = "Excel smoke.xlsx";
    run("excel", ["create", excel, "Data"], JSON.stringify([{ item: text, amount: 250 }]));
    const data = JSON.parse(run("excel", ["read", excel, "Data"]));
    if (JSON.stringify(data.data) !== JSON.stringify([[text, 250]])) throw new Error("Unexpected XLSX readback.");
    skill = "PowerPoint";
    const ppt = "PPT smoke.pptx";
    run("ppt", ["create", ppt], JSON.stringify([{ title: text, body: "Editable" }]));
    if (run("ppt", ["extract", ppt]) !== `Slide 1\n${text}\nEditable\n`) throw new Error("Unexpected PPTX readback.");
    skill = "WX";
    const review = run("wx", ["review", output, "WX smoke"]);
    if (!/Review complete: \d+(?:\.\d+)?\/100/.test(review)) throw new Error("Missing WX review score.");
    await access(join(workspace, "WX smoke", "review.md"));
  } catch (error) {
    throw new Error(`Office ${skill} package smoke test failed: ${error.message}`, { cause: error });
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
  const wx = process.env.PI_CODE_WX_RUNTIME_DIR;
  if (!wx || !isAbsolute(wx)) {
    throw new Error("Set PI_CODE_WX_RUNTIME_DIR to the absolute path of the unpacked WX offline package.");
  }
  await verifyOfflineOfficeRuntime(runtime);
  await verifyOfflineWxRuntime(wx);
  const resources = join(appOutDir, "resources");
  await cp(runtime, join(resources, "office-runtime"), { recursive: true, verbatimSymlinks: true });
  await cp(wx, join(resources, "wx-runtime"), { recursive: true, verbatimSymlinks: true });
  await cp(plugin, join(resources, "plugins", "pie.offline-office"), { recursive: true });
}
