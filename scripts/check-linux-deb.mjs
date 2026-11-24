#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MIN_LINUX_GLIBC, formatGlibcVersion, hostGlibcWithinFloor, maxNeededGlibc } from "../apps/desktop/electron/main/linux-glibc.ts";
import { ModelsDevCatalog } from "../apps/desktop/electron/main/models-dev-catalog.ts";

const [arch, deb, ...extra] = process.argv.slice(2);
const targets = { arm64: { deb: "arm64", elf: 183 }, x64: { deb: "amd64", elf: 62 } };
if (!Object.hasOwn(targets, arch) || !deb || extra.length) {
  throw new Error("Usage: node scripts/check-linux-deb.mjs <arm64|x64> <package.deb>");
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
const depends = new Set(fields.Depends?.split(/,\s*/));
for (const entry of pkg.build.deb.depends) {
  if (!depends.has(entry)) throw new Error(`Missing Debian dependency: ${entry}`);
}

const root = mkdtempSync(path.join(tmpdir(), "pi-linux-deb-"));
try {
  execFileSync("dpkg-deb", ["-x", deb, root], { stdio: "inherit" });
  const app = path.join(root, "opt/PI-Desktop");
  const required = new Set(["pi-desktop", "resources/bin/pi-desktop-host-core"]);
  if (!existsSync(path.join(app, "resources/app.asar"))) throw new Error("Missing app.asar");
  const catalog = new ModelsDevCatalog({ catalogPath: path.join(app, "resources/models.dev/api.json") });
  await catalog.loadLocal();
  const { fetchedAt, modelCount, lastError } = catalog.getStatus();
  if (!fetchedAt) throw new Error(lastError ?? "Packaged models.dev snapshot has no fetch date");
  console.log(`Verified packaged models.dev catalog: ${modelCount} models, fetched ${fetchedAt}.`);

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
} finally {
  rmSync(root, { recursive: true, force: true });
}
