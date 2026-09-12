import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { check } from "./check.js";
import { scaffold } from "./templates.js";

const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-devkit-check-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  while (created.length) {
    await rm(created.pop()!, { recursive: true, force: true });
  }
});

async function editManifest(
  dir: string,
  mutate: (manifest: Record<string, any>) => void,
): Promise<void> {
  const path = join(dir, "manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  mutate(manifest);
  await writeFile(path, JSON.stringify(manifest, null, 2), "utf8");
}

describe("check", () => {
  it("measures the package the way pack ships it: no dist/, no credential files", async () => {
    const dir = join(await tempDir(), "sized");
    await scaffold({ dir, template: "panel-basic" });
    const clean = await check(dir);
    expect(clean.ok).toBe(true);

    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(join(dir, "dist/old.piplug"), "x".repeat(4096), "utf8");
    await writeFile(join(dir, ".env"), "TOKEN=secret", "utf8");
    await writeFile(join(dir, "server.pem"), "-----BEGIN-----", "utf8");
    await writeFile(join(dir, ".npmrc"), "//registry/:_authToken=abc", "utf8");

    const result = await check(dir);
    expect(result.ok).toBe(true);
    expect(result.fileCount).toBe(clean.fileCount);
    expect(result.totalBytes).toBe(clean.totalBytes);
    const skipped = result.warnings.find((w) => w.code === "package.secret-skipped");
    expect(skipped?.message).toContain(".env");
    expect(skipped?.message).toContain("server.pem");
    expect(skipped?.message).toContain(".npmrc");
    expect(skipped?.message).not.toContain("dist/");
  });

  it("warns when manifest.icon names a file that does not exist", async () => {
    const dir = join(await tempDir(), "iconless");
    await scaffold({ dir, template: "panel-basic" });
    await editManifest(dir, (m) => {
      m.icon = "icon.png";
    });
    const missing = await check(dir);
    expect(missing.ok).toBe(true);
    expect(missing.warnings.map((w) => w.code)).toContain("icon.missing");

    await writeFile(join(dir, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const present = await check(dir);
    expect(present.warnings.map((w) => w.code)).not.toContain("icon.missing");
  });

  it("warns, without failing, when net.domains admits loopback or metadata hosts", async () => {
    const dir = join(await tempDir(), "localnet");
    await scaffold({ dir, template: "panel-basic" });
    await editManifest(dir, (m) => {
      m.permissions = [...(m.permissions ?? []), "net.fetch"];
      m.net = { domains: ["api.example.com", "localhost", "169.254.169.254"] };
    });
    const result = await check(dir);
    expect(result.ok).toBe(true);
    const warning = result.warnings.find((w) => w.code === "net.local-domain");
    expect(warning?.message).toContain("localhost");
    expect(warning?.message).toContain("169.254.169.254");
    expect(warning?.message).not.toContain("api.example.com");

    await editManifest(dir, (m) => {
      m.net = { domains: ["api.example.com"] };
    });
    expect((await check(dir)).warnings.map((w) => w.code)).not.toContain("net.local-domain");
  });

  it("rejects a manifest id outside the schema's dotted lowercase shape", async () => {
    const dir = join(await tempDir(), "badid");
    await scaffold({ dir, template: "panel-basic" });
    await editManifest(dir, (m) => {
      m.id = "Bad Id/../x";
    });
    const result = await check(dir);
    expect(result.ok).toBe(false);
    expect(result.errors.map((e) => e.code)).toContain("manifest.invalid-id");
  });
});
