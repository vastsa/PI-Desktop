import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pack } from "./pack.js";
import { scaffold } from "./templates.js";

const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-devkit-pack-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  while (created.length) {
    await rm(created.pop()!, { recursive: true, force: true });
  }
});

type ReadEntry = { name: string; method: number; data: Buffer };

/**
 * Sequential local-header reader matching host-core's `extract_zip_bytes`.
 * If this can read the package, so can the installer.
 */
function readZipLikeHostCore(bytes: Buffer): ReadEntry[] {
  expect(bytes.length).toBeGreaterThanOrEqual(22);
  const entries: ReadEntry[] = [];
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    const sig = bytes.readUInt32LE(offset);
    if (sig === 0x02014b50 || sig === 0x06054b50) break;
    expect(sig).toBe(0x04034b50);
    const method = bytes.readUInt16LE(offset + 8);
    const compSize = bytes.readUInt32LE(offset + 18);
    const nameLen = bytes.readUInt16LE(offset + 26);
    const extraLen = bytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLen;
    expect(nameEnd + extraLen + compSize).toBeLessThanOrEqual(bytes.length);
    const name = bytes.subarray(nameStart, nameEnd).toString("utf8");
    const dataStart = nameEnd + extraLen;
    const dataEnd = dataStart + compSize;
    entries.push({ name, method, data: bytes.subarray(dataStart, dataEnd) });
    offset = dataEnd;
  }
  return entries;
}

describe("pack", () => {
  it("writes a store-only piplug host-core can extract", async () => {
    const dir = join(await tempDir(), "packable");
    await scaffold({ dir, template: "full-demo" });

    const result = await pack(dir);
    expect(result.fileName).toBe("local.packable-0.1.0.piplug");
    expect(result.packagePath).toBe(join(dir, "dist", result.fileName));

    const bytes = await readFile(result.packagePath);
    expect(bytes.length).toBe(result.byteLength);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(result.shasum);

    const entries = readZipLikeHostCore(bytes);
    // Every entry must be stored: `extract_zip_bytes` bails on method != 0.
    expect(entries.every((entry) => entry.method === 0)).toBe(true);
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      "README.md",
      "main.js",
      "manifest.json",
      "renderer/index.html",
      "skills/packable.md",
    ]);
    expect(result.fileCount).toBe(entries.length);

    const manifestEntry = entries.find((entry) => entry.name === "manifest.json")!;
    expect(JSON.parse(manifestEntry.data.toString("utf8")).id).toBe("local.packable");
    const onDisk = await readFile(join(dir, "renderer/index.html"));
    const packed = entries.find((entry) => entry.name === "renderer/index.html")!;
    expect(packed.data.equals(onDisk)).toBe(true);
  });

  it("uses forward slashes so nested paths extract on every platform", async () => {
    const dir = join(await tempDir(), "nested");
    await scaffold({ dir, template: "panel-basic" });
    const bytes = await readFile((await pack(dir)).packagePath);
    const names = readZipLikeHostCore(bytes).map((entry) => entry.name);
    expect(names).toContain("renderer/index.html");
    expect(names.some((name) => name.includes("\\"))).toBe(false);
  });

  it("excludes node_modules and its own dist output", async () => {
    const dir = join(await tempDir(), "excluded");
    await scaffold({ dir, template: "panel-basic" });
    await mkdir(join(dir, "node_modules/dep"), { recursive: true });
    await writeFile(join(dir, "node_modules/dep/index.js"), "noop", "utf8");

    await pack(dir);
    // Second pack must not swallow the first package.
    const bytes = await readFile((await pack(dir)).packagePath);
    const names = readZipLikeHostCore(bytes).map((entry) => entry.name);
    expect(names.some((name) => name.startsWith("node_modules/"))).toBe(false);
    expect(names.some((name) => name.startsWith("dist/"))).toBe(false);
  });

  it("honours an explicit output directory", async () => {
    const dir = join(await tempDir(), "outdir");
    await scaffold({ dir, template: "panel-basic" });
    const out = join(await tempDir(), "artifacts");
    const result = await pack(dir, { outDir: out });
    expect(result.packagePath).toBe(join(out, "local.outdir-0.1.0.piplug"));
    await expect(readFile(result.packagePath)).resolves.toBeInstanceOf(Buffer);
  });

  it("refuses to package a plugin that fails check", async () => {
    const dir = join(await tempDir(), "broken");
    await scaffold({ dir, template: "panel-basic" });
    await rm(join(dir, "main.js"));
    await expect(pack(dir)).rejects.toThrow(/plugin check failed[\s\S]*main/);
  });

  it("surfaces check warnings alongside a successful pack", async () => {
    const dir = join(await tempDir(), "warned");
    await scaffold({ dir, template: "full-demo" });
    const result = await pack(dir);
    expect(result.check.ok).toBe(true);
    expect(result.check.warnings.map((w) => w.code)).toContain("permission.high-risk");
  });
});
