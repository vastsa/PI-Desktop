import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, lstat, readdir, readFile, readlink, realpath, symlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

const plugin = new URL("../apps/desktop/resources/office-runtime/", import.meta.url);
const ARM64 = 3; // electron-builder's Arch.arm64.
const stdlib = "python/lib/python3.12";
const site = stdlib + "/site-packages";
const executables = ["node/bin/node", "python/bin/python3.12"];
const metadata = ["metadata/runtime-source.json", "metadata/package-lock.json"];
const pythonPackages = ["defusedxml", "lxml"];
const nodePackages = ["docx", "fflate", "nanoid"];
const legacyPath = /(?:^|[\\/])(?:pie\.offline-office|wx-runtime|SKILL\.md)(?:[\\/]|$)/i;
const archive = /\.(?:zip|whl|tgz|gz|xz|zst|tar|piplug|docx|pptx|xlsx)$/i;

async function verifyRuntimeLinks(runtime, checkPayload) {
  if (!(await lstat(runtime)).isDirectory()) throw new Error("Office Runtime root must be a directory.");
  const root = await realpath(runtime);
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const link = join(entry.parentPath, entry.name);
    const name = relative(root, link);
    if (checkPayload && (legacyPath.test(name) || archive.test(name))) throw new Error(`Unexpected Office Runtime file: ${name}`);
    if (!entry.isSymbolicLink()) continue;
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

async function lockedNodePackages(runtime) {
  const { packages } = JSON.parse(await readFile(join(runtime, metadata[1]), "utf8"));
  if (packages?.["node_modules/docx"]?.version !== "9.16.0") {
    throw new Error("Expected docx 9.16.0 in the Office Runtime lockfile.");
  }
  return await Promise.all(nodePackages.map(async (pkg) => {
    const name = `node_modules/${pkg}`;
    const directory = join("node/lib", name);
    const installed = JSON.parse(await readFile(join(runtime, directory, "package.json"), "utf8"));
    const expected = packages[name]?.version;
    if (typeof expected !== "string" || installed.version !== expected) {
      throw new Error(`Office Runtime version mismatch: ${name}`);
    }
    await access(join(runtime, directory, "LICENSE"), constants.R_OK);
    return directory;
  }));
}

export async function verifyOfflineOfficeRuntime(runtime) {
  await verifyRuntimeLinks(runtime, true);
  for (const executable of [...executables, "python/bin/python", "python/bin/python3"]) {
    await access(join(runtime, executable), constants.X_OK);
  }
  for (const name of [metadata[0], "node/LICENSE", stdlib + "/LICENSE.txt",
    ...pythonPackages.map((pkg) => `${site}/${pkg}/__init__.py`)]) {
    await access(join(runtime, name), constants.R_OK);
  }
  await lockedNodePackages(runtime);
  const entries = await readdir(join(runtime, site), { recursive: true });
  for (const pkg of pythonPackages) {
    if (!entries.some((name) => name.startsWith(pkg + "-") && /\.dist-info[\\/](?:licenses[\\/])?LICENSE/i.test(name))) {
      throw new Error(`Office Runtime license is missing: ${pkg}`);
    }
  }
}

export function smokeTestOfflineOffice(resources) {
  const runtime = join(resources, "office-runtime");
  const node = join(runtime, executables[0]);
  const python = join(runtime, executables[1]);
  const opts = { encoding: "utf8", stdio: "pipe", timeout: 30_000 };
  try {
    execFileSync(node, ["-e", `
const docx = require.resolve('docx');
if (!docx.startsWith(process.env.NODE_PATH + '/docx/')) throw new Error('docx resolved outside Office Runtime');
const { Document, Packer } = require(docx);
Packer.toBuffer(new Document({ sections: [] }));
`], {
      ...opts, cwd: runtime, env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: join(runtime, "node/lib/node_modules") },
    });
    execFileSync(python, ["-I", "-B", "-c", "import defusedxml.minidom, lxml.etree, zipfile"], opts);
  } catch (error) {
    throw new Error(`Office Runtime package smoke test failed: ${error.message}`, { cause: error });
  }
}

export default async function bundleOfflineOffice(context, runtime = process.env.PI_CODE_OFFICE_RUNTIME_DIR) {
  const { electronPlatformName, arch, appOutDir, targets } = context;
  if (electronPlatformName !== "linux" || arch !== ARM64 || !targets.some((target) => target.name === "deb")) return;
  if (!runtime) return;
  if (targets.length !== 1) throw new Error("Build the Office Runtime Debian candidate with dist:kylin.");
  if (!isAbsolute(runtime)) {
    throw new Error("Set PI_CODE_OFFICE_RUNTIME_DIR to the absolute path of the staged ARM64 Office Runtime.");
  }
  await verifyRuntimeLinks(runtime, false);
  const resources = join(appOutDir, "resources");
  const output = join(resources, "office-runtime");
  const copy = (name, filter) => cp(join(runtime, name), join(output, name), {
    recursive: true, verbatimSymlinks: true, filter,
  });
  const keep = (source) => !legacyPath.test(relative(runtime, source)) && !archive.test(source) &&
    !/(?:^|[\\/])(?:__pycache__|tests?|examples?)(?:[\\/]|$)/.test(relative(runtime, source)) &&
    !/\.(?:pyc|map|h)$|\.d\.[cm]?ts$|(?:^|[\\/])_tkinter[^\\/]*\.so$/.test(source);

  for (const name of [...executables, ...metadata, "node/LICENSE", "python/lib/libpython3.12.so.1.0",
    ...await lockedNodePackages(runtime)]) {
    await copy(name, keep);
  }
  await copy(stdlib, (source) => {
    const top = relative(join(runtime, stdlib), source).split(sep)[0];
    return !/^(?:site-packages|config-.*|ensurepip|idlelib|tkinter|turtledemo|venv)$/.test(top) && keep(source);
  });
  const entries = await readdir(join(runtime, site));
  for (const pkg of pythonPackages) {
    const distribution = entries.filter((entry) => entry.startsWith(pkg + "-") && entry.endsWith(".dist-info"));
    if (distribution.length !== 1) throw new Error(`Expected one installed Office Runtime distribution: ${pkg}`);
    for (const entry of [pkg, ...distribution, ...entries.filter((entry) => entry === pkg + ".libs")]) {
      await copy(`${site}/${entry}`, (source) => keep(source) && !/[\\/](?:includes|isoschematron|html)(?:[\\/]|$)/.test(relative(runtime, source)));
    }
  }
  await symlink("python3.12", join(output, "python/bin/python"));
  await symlink("python3.12", join(output, "python/bin/python3"));
  await verifyOfflineOfficeRuntime(output);
  await cp(plugin, join(resources, "plugins", "pie.office-runtime"), { recursive: true });
}
