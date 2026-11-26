import { execFileSync } from "node:child_process";
import { constants, mkdtempSync, rmSync } from "node:fs";
import { access, chmod, cp, lstat, mkdir, readdir, readFile, readlink, realpath, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";

const plugin = new URL("../apps/desktop/resources/office-runtime/", import.meta.url);
const ARM64 = 3; // electron-builder's Arch.arm64.
const stdlib = "python/lib/python3.12";
const site = stdlib + "/site-packages";
const renderCommands = ["soffice", "pdftoppm"];
const executables = ["node/bin/node", "python/bin/python3.12"];
const nativeMetadata = "metadata/native-office";
const nativeRuntime = ["libreoffice", "poppler", nativeMetadata];
const requiredNativePackages = ["libreoffice-core", "libreoffice-impress", "poppler", "poppler-utils"];
const metadata = ["metadata/runtime-source.json", "metadata/package-lock.json", "metadata/python-dependencies.json"];
const pythonPackages = {
  beautifulsoup4: ["bs4"], certifi: ["certifi"], charset_normalizer: ["charset_normalizer"],
  click: ["click"], defusedxml: ["defusedxml"], flatbuffers: ["flatbuffers"], idna: ["idna"],
  lxml: ["lxml"], magika: ["magika"], markdownify: ["markdownify"], markitdown: ["markitdown"],
  numpy: ["numpy"], onnxruntime: ["onnxruntime"], packaging: ["packaging"], pillow: ["PIL"],
  protobuf: ["google/protobuf", "google/_upb"], python_dotenv: ["dotenv"], python_pptx: ["pptx"],
  requests: ["requests"], six: ["six.py"], soupsieve: ["soupsieve"],
  typing_extensions: ["typing_extensions.py"], urllib3: ["urllib3"], xlsxwriter: ["xlsxwriter"],
};
const nodePackages = ["docx", "fflate", "nanoid", "pptxgenjs", "image-size", "queue", "inherits",
  "jszip", "lie", "pako", "setimmediate", "immediate", "core-util-is", "process-nextick-args",
  "util-deprecate", "readable-stream", "isarray", "safe-buffer", "string_decoder"];
const license = /^(?:license|copying|notice)(?:[._-].*)?$/i;
const legacyPath = /(?:^|[\\/])(?:pie\.offline-office|wx-runtime|SKILL\.md)(?:[\\/]|$)/i;
const archive = /\.(?:zip|whl|tgz|gz|xz|zst|tar|piplug|docx|pptx|xlsx)$/i;
const readJson = async (runtime, name) => JSON.parse(await readFile(join(runtime, name), "utf8"));

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
  const { packages } = await readJson(runtime, metadata[1]);
  if (packages?.["node_modules/docx"]?.version !== "9.16.0") {
    throw new Error("Expected docx 9.16.0 in the Office Runtime lockfile.");
  }
  if (packages["node_modules/pptxgenjs"]?.version !== "4.0.1") {
    throw new Error("Expected pptxgenjs 4.0.1 in the Office Runtime lockfile.");
  }
  return await Promise.all(nodePackages.map(async (pkg) => {
    const name = `node_modules/${pkg}`;
    const directory = join("node/lib", name);
    const installed = await readJson(runtime, join(directory, "package.json"));
    const expected = packages[name]?.version;
    if (typeof expected !== "string" || installed.version !== expected) {
      throw new Error(`Office Runtime version mismatch: ${name}`);
    }
    if (!(await readdir(join(runtime, directory))).some((file) => license.test(file))) {
      throw new Error(`Office Runtime license is missing: ${name}`);
    }
    return directory;
  }));
}

async function pythonRuntimeFiles(runtime) {
  const { packages } = await readJson(runtime, "metadata/python-dependencies.json");
  if (!Array.isArray(packages)) throw new Error("Missing Python dependency sources in Office Runtime.");
  const versions = new Map(packages.map(({ name, version }) => [name.replaceAll("-", "_"), version]));
  const entries = await readdir(join(runtime, site));
  const files = [];
  for (const [pkg, modules] of Object.entries(pythonPackages)) {
    const distributions = entries.filter((entry) => entry.startsWith(pkg + "-") && entry.endsWith(".dist-info"));
    if (distributions.length !== 1) throw new Error(`Expected one installed Office Runtime distribution: ${pkg}`);
    const [distribution] = distributions;
    if (!versions.has(pkg) || distribution !== `${pkg}-${versions.get(pkg)}.dist-info`) {
      throw new Error(`Office Runtime Python version mismatch: ${pkg}`);
    }
    const notices = await readdir(join(runtime, site, distribution), { recursive: true });
    if (!notices.some((name) => license.test(name.split(sep).at(-1)))) {
      throw new Error(`Office Runtime license is missing: ${pkg}`);
    }
    files.push(distribution, ...modules, ...entries.filter((entry) => entry === pkg + ".libs"));
  }
  return files.map((name) => `${site}/${name}`);
}

async function verifyNativeNotices(runtime) {
  const { packages } = await readJson(runtime, `${nativeMetadata}/sources.json`);
  if (!Array.isArray(packages) || !packages.length) throw new Error("Missing native dependency sources in Office Runtime.");
  const leaf = (name) => typeof name === "string" && name !== "." && name !== ".." && basename(name) === name && name.length > 0;
  const seen = new Set();
  for (const { name, version, source, notices } of packages) {
    if (!leaf(name) || typeof source?.url !== "string" || !source.url.trim() ||
        !Array.isArray(notices) || !notices.length || !notices.every(leaf)) {
      throw new Error(`Office Runtime source or license notice is missing: ${name}`);
    }
    if (typeof version !== "string" || !version.trim()) {
      throw new Error(`Office Runtime native dependency version is missing: ${name}`);
    }
    if (seen.has(name)) throw new Error(`Duplicate native Office Runtime package: ${name}`);
    seen.add(name);
    for (const notice of notices) {
      const file = await stat(join(runtime, nativeMetadata, "licenses", name, notice));
      if (!file.isFile() || !file.size) throw new Error(`Office Runtime license notice is empty: ${name}/${notice}`);
    }
  }
  for (const name of requiredNativePackages) {
    if (!seen.has(name)) throw new Error("Missing native Office Runtime package: " + name);
  }
}

export async function verifyOfflineOfficeRuntime(runtime) {
  await verifyRuntimeLinks(runtime, true);
  for (const executable of [...executables, "python/bin/python", "python/bin/python3",
    "libreoffice/program/oosplash", "poppler/bin/pdftoppm", ...renderCommands.map((name) => `bin/${name}`)]) {
    await access(join(runtime, executable), constants.X_OK);
  }
  for (const name of [...metadata, "node/LICENSE", stdlib + "/LICENSE.txt", ...nativeRuntime, ...await pythonRuntimeFiles(runtime)]) {
    await access(join(runtime, name), constants.R_OK);
  }
  await lockedNodePackages(runtime);
  await verifyNativeNotices(runtime);
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
const pptxModule = require.resolve('pptxgenjs');
if (!pptxModule.startsWith(process.env.NODE_PATH + '/pptxgenjs/')) throw new Error('pptxgenjs resolved outside Office Runtime');
const PptxGenJS = require(pptxModule);
const pptx = new PptxGenJS();
pptx.addSlide().addText('Editable text');
Promise.all([Packer.toBuffer(new Document({ sections: [] })), pptx.write({ outputType: 'nodebuffer' })]);
`], {
      ...opts, cwd: runtime, env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: join(runtime, "node/lib/node_modules") },
    });
    execFileSync(python, ["-I", "-B", "-c", "import defusedxml.minidom, lxml.etree, PIL.Image, pptx; from markitdown import MarkItDown; MarkItDown()"], opts);
    const profiles = mkdtempSync(join(tmpdir(), "pie-office-inspection-"));
    try {
      execFileSync(join(runtime, "bin/soffice"), ["--headless", "--version"], {
        ...opts, env: { ...process.env, PI_OFFICE_RUNTIME_PROFILES: profiles },
      });
    } finally {
      rmSync(profiles, { recursive: true, force: true });
    }
    execFileSync(join(runtime, "bin/pdftoppm"), ["-v"], opts);
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
  const keep = (source) => {
    const name = relative(runtime, source).split(sep).join("/");
    if (name.startsWith("poppler/bin/")) return name === "poppler/bin/pdftoppm";
    return !legacyPath.test(name) && !archive.test(name) &&
      !/(?:^|\/)(?:__pycache__|tests?|examples?)(?:\/|$)/.test(name) &&
      !/\.(?:pyc|map|h)$|\.d\.[cm]?ts$|(?:^|\/)_tkinter[^/]*\.so$/.test(name) &&
      !/^libreoffice\/(?:presets\/(?:basic|database)|share\/autotext|program\/(?:gdbtrace|opencltest|JREProperties\.class))(?:\/|$)/.test(name);
  };

  const nodeRuntime = await lockedNodePackages(runtime);
  for (const name of [...executables, ...metadata, ...nativeRuntime, "node/LICENSE", "python/lib/libpython3.12.so.1.0",
    ...nodeRuntime]) {
    await copy(name, keep);
  }
  await copy(stdlib, (source) => {
    const top = relative(join(runtime, stdlib), source).split(sep)[0];
    return !/^(?:site-packages|config-.*|ensurepip|idlelib|tkinter|turtledemo|venv)$/.test(top) && keep(source);
  });
  for (const name of await pythonRuntimeFiles(runtime)) {
    await copy(name, (source) => keep(source) &&
      (name !== `${site}/lxml` || !/[\\/](?:includes|isoschematron|html)(?:[\\/]|$)/.test(relative(runtime, source))));
  }
  await mkdir(join(output, "bin"));
  for (const name of renderCommands) {
    const destination = join(output, "bin", name);
    await cp(new URL(`office-runtime-bin/${name}`, import.meta.url), destination);
    await chmod(destination, 0o755);
  }
  await symlink("python3.12", join(output, "python/bin/python"));
  await symlink("python3.12", join(output, "python/bin/python3"));
  await verifyOfflineOfficeRuntime(output);
  await cp(plugin, join(resources, "plugins", "pie.office-runtime"), { recursive: true });
}
