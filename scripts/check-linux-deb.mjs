#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MIN_LINUX_GLIBC, formatGlibcVersion, hostGlibcWithinFloor, maxNeededGlibc } from "../apps/desktop/electron/main/linux-glibc.ts";
import { ModelsDevCatalog } from "../apps/desktop/electron/main/models-dev-catalog.ts";
import { smokeTestOfflineOffice, verifyOfflineOfficeRuntime, verifyOfflineWxRuntime } from "./bundle-offline-office.mjs";

const [arch, deb, officeFlag, ...extra] = process.argv.slice(2);
const targets = { arm64: { deb: "arm64", elf: 183 }, x64: { deb: "amd64", elf: 62 } };
if (!Object.hasOwn(targets, arch) || !deb || extra.length ||
  (officeFlag !== undefined && (arch !== "arm64" || officeFlag !== "--with-offline-office"))) {
  throw new Error("Usage: node scripts/check-linux-deb.mjs <arm64|x64> <package.deb> [--with-offline-office]");
}

function inspect(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

const pkg = JSON.parse(readFileSync(new URL("../apps/desktop/package.json", import.meta.url)));
const metadata = inspect("dpkg-deb", ["-f", deb, "Package", "Version", "Architecture", "Depends"]);
console.log(metadata);
const fields = Object.fromEntries(metadata.split("\n").map((field) => field.split(/:\s+/, 2)));
for (const [key, expected] of Object.entries({
  Package: pkg.build.deb.packageName,
  Version: pkg.version.replaceAll("-", "~"),
  Architecture: targets[arch].deb,
})) {
  if (fields[key] !== expected) throw new Error(`Expected ${key} ${expected}, got ${fields[key]}`);
}
const filename = path.basename(deb);
const genericLabel = filename.endsWith("_generic.deb");
const expectedArm64 = `pie-code_${pkg.version}_arm64`;
if (arch === "arm64" && filename !== `${expectedArm64}.deb` &&
    (officeFlag || filename !== `${expectedArm64}_generic.deb`)) {
  throw new Error(`Unexpected ARM64 package filename: ${filename}`);
}
for (const relation of ["Conflicts", "Breaks", "Replaces", "Provides"]) {
  const value = inspect("dpkg-deb", ["-f", deb, relation]);
  if (/(?:^|,\s*)pi-desktop(?:\s|:|,|$)/.test(value)) {
    throw new Error(`${relation} must not claim the upstream pi-desktop package`);
  }
}
const depends = new Set(fields.Depends?.split(/,\s*/));
for (const entry of pkg.build.deb.depends) {
  if (!depends.has(entry)) throw new Error(`Missing Debian dependency: ${entry}`);
}

const root = mkdtempSync(path.join(tmpdir(), "pi-linux-deb-"));
try {
  execFileSync("dpkg-deb", ["-x", deb, root], { stdio: "inherit" });
  const { productName, linux: { executableName } } = pkg.build;
  const app = path.join(root, "opt", productName);
  const required = new Set([executableName, "resources/bin/pi-desktop-host-core"]);
  const resources = path.join(app, "resources");
  const runtime = path.join(resources, "office-runtime");
  const officePlugin = path.join(resources, "plugins/pie.offline-office");
  const wx = path.join(resources, "wx-runtime");
  const withOffice = officeFlag || existsSync(runtime) || existsSync(officePlugin) || existsSync(wx);
  if (withOffice) {
    if (arch !== "arm64" || genericLabel) {
      throw new Error("Offline Office requires a dedicated ARM64 Debian package.");
    }
    await verifyOfflineOfficeRuntime(runtime);
    await verifyOfflineWxRuntime(wx);
    for (const file of [
      "manifest.json", "main.cjs", "office_document.py",
      "word/SKILL.md", "word/word.sh", "word/create.cjs", "word/document.py",
      "excel/SKILL.md", "excel/excel.sh", "excel/spreadsheet.py",
      "ppt/SKILL.md", "ppt/ppt.sh", "ppt/presentation.py",
      "wx/SKILL.md", "wx/wx.sh",
    ]) {
      if (!existsSync(path.join(officePlugin, file))) {
        throw new Error(`Missing bundled Offline Office plugin file: ${file}`);
      }
    }
    required.add("resources/office-runtime/node/bin/node");
    required.add("resources/office-runtime/python/bin/python3.12");
    required.add("resources/office-runtime/libreoffice/program/soffice.bin");
  }
  if (!existsSync(path.join(app, "resources/app.asar"))) throw new Error("Missing app.asar");
  const catalog = new ModelsDevCatalog({ catalogPath: path.join(app, "resources/models.dev/api.json") });
  await catalog.loadLocal();
  const { fetchedAt, modelCount, lastError } = catalog.getStatus();
  if (!fetchedAt) throw new Error(lastError ?? "Packaged models.dev snapshot has no fetch date");
  console.log(`Verified packaged models.dev catalog: ${modelCount} models, fetched ${fetchedAt}.`);
  const desktopFile = readFileSync(path.join(root, "usr/share/applications", pkg.desktopName), "utf8");
  for (const line of [
    `Name=${productName}`,
    `Exec="/opt/${productName}/${executableName}" %U`,
    `Icon=${executableName}`,
    `StartupWMClass=${executableName}`,
  ]) {
    if (!desktopFile.split(/\r?\n/).includes(line)) throw new Error(`Missing desktop entry: ${line}`);
  }
  for (const size of [16, 24, 32, 48, 64, 96, 512]) {
    const icon = path.join(root, "usr/share/icons/hicolor", `${size}x${size}`, "apps", `${executableName}.png`);
    if (!existsSync(icon)) throw new Error(`Missing launcher icon at ${size}x${size}: ${icon}`);
    const png = readFileSync(icon);
    if (png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) {
      throw new Error(`Invalid launcher icon size: ${icon}`);
    }
    if (size === 512) {
      const fallback = path.join(root, "usr/share/pixmaps", `${executableName}.png`);
      if (!existsSync(fallback) || !png.equals(readFileSync(fallback))) {
        throw new Error(`Missing or mismatched UKUI launcher fallback icon: ${fallback}`);
      }
    }
  }

  const header = Buffer.alloc(20);
  const floor = formatGlibcVersion(MIN_LINUX_GLIBC);
  let verified = 0;
  for (const entry of readdirSync(app, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const relative = path.relative(app, file);
    const fd = openSync(file, "r");
    let size;
    try {
      size = readSync(fd, header, 0, header.length, 0);
    } finally {
      closeSync(fd);
    }
    if (size < header.length || header.readUInt32BE(0) !== 0x7f454c46) continue;

    const machine = header[5] === 1 ? header.readUInt16LE(18) : header.readUInt16BE(18);
    const versions = inspect("readelf", ["--wide", "--version-info", file]);
    const needed = maxNeededGlibc(versions);
    const glibc = needed ? formatGlibcVersion(needed) : "none";
    // The optional microphone SDK intentionally bundles other architectures
    // and some Raspberry Pi builds with a higher floor. It is not in the launch path.
    if (entry.name === "pv_recorder.node" && relative.includes("/@picovoice/pvrecorder-node/")) {
      console.log(`Optional microphone add-on: ${relative} (ELF machine ${machine}, glibc ${glibc})`);
      continue;
    }
    if (machine !== targets[arch].elf || header[4] !== 2 || header[5] !== 1) {
      throw new Error(`${relative} is not a 64-bit little-endian ${arch} ELF (machine ${machine})`);
    }
    if (!hostGlibcWithinFloor(needed) || versions.includes("GLIBC_ABI_DT_RELR")) {
      throw new Error(`${relative} exceeds the glibc ${floor} floor (glibc ${glibc})`);
    }
    required.delete(relative);
    verified += 1;
  }
  if (required.size) throw new Error(`Missing required ELF files: ${[...required].join(", ")}`);
  console.log(`Verified ${verified} ${arch} ELF files at glibc <= ${floor}.`);
  if (withOffice) {
    await smokeTestOfflineOffice(resources);
    console.log("Verified bundled Word and PowerPoint creation/extraction, Excel creation/read, and WX review.");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
