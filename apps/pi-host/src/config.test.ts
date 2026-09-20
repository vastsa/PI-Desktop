import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseArgs, resolveConfig } from "./config.js";
import { FileCredentialStore, loadOrCreateHostId } from "./credentials.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-host-test-"));
  dirs.push(dir);
  return dir;
}

describe("config", () => {
  it("parses flags with and without values and validates the port", () => {
    expect(parseArgs(["--pair", "--port", "4123", "--data-dir=/x", "--host-core", "/bin/hc"])).toEqual({ pair: true, port: "4123", "data-dir": "/x", "host-core": "/bin/hc" });
    const config = resolveConfig({ "data-dir": "/data", port: "4123", "host-core": "/bin/hc", sidecar: "/s.js", pair: true }, {});
    expect(config).toMatchObject({ dataDir: "/data", port: 4123, host: "127.0.0.1", hostCoreBinary: "/bin/hc", sidecarEntry: "/s.js", pair: true, logLevel: "info" });
    expect(() => resolveConfig({ port: "70000", "host-core": "/bin/hc", sidecar: "/s.js" }, {})).toThrow(/invalid port/);
    expect(() => resolveConfig({ "host-core": "/bin/hc", sidecar: "/s.js", port: "abc" }, {})).toThrow(/invalid port/);
    expect(resolveConfig({ "host-core": "/bin/hc", sidecar: "/s.js", "log-level": "warn" }, {}).logLevel).toBe("warn");
  });
});

describe("identity and credentials", () => {
  it("mints the host id once and keeps it across restarts", async () => {
    const dir = await tempDir();
    const first = await loadOrCreateHostId(dir);
    expect(first.startsWith("host_")).toBe(true);
    expect(await loadOrCreateHostId(dir)).toBe(first);
    const info = await stat(join(dir, "pi-host", "identity.json"));
    expect(info.mode & 0o077).toBe(0);
  });

  it("stores devices and pairings hashed, owner-readable, and survives a reload", async () => {
    const dir = await tempDir();
    const store = new FileCredentialStore(dir);
    await store.saveDevice({ deviceId: "dev_1", label: "laptop", roles: ["owner"], tokenHash: "ab".repeat(32), createdAt: "2026-09-18T00:00:00.000Z" });
    await store.savePairing({ tokenHash: "cd".repeat(32), expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await store.savePairing({ tokenHash: "ef".repeat(32), expiresAt: "2000-01-01T00:00:00.000Z" });
    const raw = await readFile(join(dir, "pi-host", "credentials.json"), "utf8");
    expect(raw).not.toContain("pdt1.");
    expect(raw).toContain("ab".repeat(32));
    expect(raw).not.toContain("ef".repeat(32));
    const info = await stat(join(dir, "pi-host", "credentials.json"));
    expect(info.mode & 0o077).toBe(0);

    const reloaded = new FileCredentialStore(dir);
    expect((await reloaded.findDeviceByTokenHash("ab".repeat(32)))?.deviceId).toBe("dev_1");
    expect(await reloaded.consumePairing("cd".repeat(32), "2026-09-18T00:00:01.000Z")).toBe(true);
    expect(await reloaded.consumePairing("cd".repeat(32), "2026-09-18T00:00:02.000Z")).toBe(false);
    expect(await reloaded.revokeDevice("dev_1", "2026-09-18T00:00:03.000Z")).toBe(true);
    expect(await reloaded.revokeDevice("dev_1", "2026-09-18T00:00:04.000Z")).toBe(false);
    const again = new FileCredentialStore(dir);
    expect((await again.listDevices())[0]?.revokedAt).toBe("2026-09-18T00:00:03.000Z");
    expect(await again.findPairing("cd".repeat(32))).toBeNull();
  });
});
