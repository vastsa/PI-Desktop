import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { check, type CheckResult } from "./check.js";
import { walkPluginDir } from "./walk.js";

export type PackResult = {
  /** Absolute path of the written `.piplug`. */
  packagePath: string;
  fileName: string;
  byteLength: number;
  /** Hex sha256 of the package, the value install-time integrity checks compare. */
  shasum: string;
  fileCount: number;
  check: CheckResult;
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

type ZipEntry = { name: string; data: Uint8Array };

/**
 * Build a store-only (uncompressed) zip.
 *
 * host-core's `extract_zip_bytes` bails with "only store-compressed piplug
 * supported" on any other method, so deflate is not an option here. The header
 * layout mirrors `make_zip` in crates/host-core/src/plugins.rs.
 */
function buildStoreZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra
    const localBlock = Buffer.concat([local, name, data]);
    locals.push(localBlock);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method: store
    central.writeUInt16LE(0, 12); // time
    central.writeUInt16LE(0, 14); // date
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));

    offset += localBlock.length;
  }

  const centralBlock = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // this disk
  eocd.writeUInt16LE(0, 6); // central dir disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBlock.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBlock, eocd]);
}

export type PackOptions = {
  /** Output directory. Defaults to `<dir>/dist`. */
  outDir?: string;
};

/**
 * Validate and package a plugin directory into an installable `.piplug`.
 *
 * `check` runs first and a failing check aborts the pack: shipping a package
 * host-core will reject at install time helps nobody.
 */
export async function pack(dirInput: string, options: PackOptions = {}): Promise<PackResult> {
  const dir = resolve(dirInput);
  const checked = await check(dir);
  if (!checked.ok || !checked.manifest) {
    const detail = checked.errors.map((e) => e.message).join("; ");
    throw new Error(`plugin check failed: ${detail}`);
  }
  const manifest = checked.manifest;

  const walk = await walkPluginDir(dir);
  // `dist/` holds our own output; packaging previous packages would nest them.
  const entries: ZipEntry[] = [];
  for (const file of walk.files) {
    if (file.path === "dist" || file.path.startsWith("dist/")) continue;
    entries.push({ name: file.path, data: await readFile(file.absolutePath) });
  }

  const bytes = buildStoreZip(entries);
  const outDir = resolve(options.outDir ?? join(dir, "dist"));
  await mkdir(outDir, { recursive: true });
  const fileName = `${manifest.id}-${manifest.version}.piplug`;
  const packagePath = join(outDir, fileName);
  await writeFile(packagePath, bytes);

  const { createHash } = await import("node:crypto");
  const shasum = createHash("sha256").update(bytes).digest("hex");

  return {
    packagePath,
    fileName,
    byteLength: bytes.length,
    shasum,
    fileCount: entries.length,
    check: checked,
  };
}
