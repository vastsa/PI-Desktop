import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RACP_DEFAULT_POLICY } from "@pi-desktop/shared";

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
    expect(parseArgs(["--apply-ceiling-to-paired-devices"])["apply-ceiling-to-paired-devices"]).toBe(true);
    const config = resolveConfig({ "data-dir": "/data", port: "4123", "host-core": "/bin/hc", sidecar: "/s.js", pair: true }, {});
    expect(config).toMatchObject({ dataDir: "/data", port: 4123, host: "127.0.0.1", hostCoreBinary: "/bin/hc", sidecarEntry: "/s.js", pair: true, logLevel: "info", policy: RACP_DEFAULT_POLICY });
    expect(() => resolveConfig({ port: "70000", "host-core": "/bin/hc", sidecar: "/s.js" }, {})).toThrow(/invalid port/);
    expect(() => resolveConfig({ "host-core": "/bin/hc", sidecar: "/s.js", port: "abc" }, {})).toThrow(/invalid port/);
    expect(resolveConfig({ "host-core": "/bin/hc", sidecar: "/s.js", "log-level": "warn" }, {}).logLevel).toBe("warn");
  });

  it("resolves the Host RACP policy from flags and environment with flag precedence", () => {
    const config = resolveConfig({
      "host-core": "/bin/hc",
      sidecar: "/s.js",
      "remote-max-permission-mode": "accept-edits",
      "apply-ceiling-to-paired-devices": "true",
      "approval-lifetime-ms": "45000",
    }, {
      PI_HOST_REMOTE_MAX_PERMISSION_MODE: "auto",
      PI_HOST_APPLY_CEILING_TO_PAIRED_DEVICES: "false",
      PI_HOST_APPROVAL_LIFETIME_MS: "90000",
    });

    expect(config.policy).toEqual({
      remoteMaxPermissionMode: "accept-edits",
      applyCeilingToPairedDevices: true,
      approvalLifetimeMs: 45_000,
    });

    const fromEnvironment = resolveConfig({ "host-core": "/bin/hc", sidecar: "/s.js" }, {
      PI_HOST_REMOTE_MAX_PERMISSION_MODE: "auto",
      PI_HOST_APPLY_CEILING_TO_PAIRED_DEVICES: "true",
      PI_HOST_APPROVAL_LIFETIME_MS: "90000",
    });
    expect(fromEnvironment.policy).toEqual({
      remoteMaxPermissionMode: "auto",
      applyCeilingToPairedDevices: true,
      approvalLifetimeMs: 90_000,
    });

    const explicitFalse = resolveConfig({ "host-core": "/bin/hc", sidecar: "/s.js", "apply-ceiling-to-paired-devices": "false" }, {
      PI_HOST_APPLY_CEILING_TO_PAIRED_DEVICES: "true",
    });
    expect(explicitFalse.policy.applyCeilingToPairedDevices).toBe(false);
  });

  it("rejects invalid Host policy values instead of silently changing policy", () => {
    const base = { "host-core": "/bin/hc", sidecar: "/s.js" };
    expect(() => resolveConfig({ ...base, "remote-max-permission-mode": "unrestricted" }, {})).toThrow(/remote-max-permission-mode/);
    expect(() => resolveConfig({ ...base, "apply-ceiling-to-paired-devices": "yes" }, {})).toThrow(/apply-ceiling-to-paired-devices/);
    expect(() => resolveConfig({ ...base, "approval-lifetime-ms": "0" }, {})).toThrow(/approval-lifetime-ms/);
    expect(() => resolveConfig({ ...base, "approval-lifetime-ms": true }, {})).toThrow(/approval-lifetime-ms/);
    expect(() => resolveConfig(base, { PI_HOST_REMOTE_MAX_PERMISSION_MODE: "unrestricted" })).toThrow(/PI_HOST_REMOTE_MAX_PERMISSION_MODE/);
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
