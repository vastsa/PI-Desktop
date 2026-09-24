import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { DeviceCredentialStore, DeviceRecord, PairingRecord } from "@pi-desktop/racp";

type IdentityFile = { hostId: string; createdAt: string };
type CredentialFile = { devices: DeviceRecord[]; pairings: PairingRecord[] };

const FILE_MODE = 0o600;

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: FILE_MODE });
  await rename(temp, path);
}

/**
 * The Host's stable identity (D448): minted once at first start and kept
 * beside the data directory. Never derived from hostname, address, or path,
 * so two machines with the same project path are still two Hosts.
 */
export async function loadOrCreateHostId(dataDir: string): Promise<string> {
  const path = join(dataDir, "pi-host", "identity.json");
  const existing = await readJson<IdentityFile>(path);
  if (existing?.hostId) return existing.hostId;
  const created: IdentityFile = { hostId: `host_${randomBytes(12).toString("base64url")}`, createdAt: new Date().toISOString() };
  await writeJsonAtomic(path, created);
  return created.hostId;
}

/**
 * Device and pairing records under `<dataDir>/pi-host/credentials.json`,
 * owner-readable only. Tokens are stored as SHA-256 hashes (security §3.4);
 * the file never holds a usable credential.
 */
export class FileCredentialStore implements DeviceCredentialStore {
  private readonly path: string;
  private state: CredentialFile | null = null;
  private chain = Promise.resolve();

  constructor(dataDir: string) {
    this.path = join(dataDir, "pi-host", "credentials.json");
  }

  private async load(): Promise<CredentialFile> {
    if (!this.state) this.state = (await readJson<CredentialFile>(this.path)) ?? { devices: [], pairings: [] };
    return this.state;
  }

  private async mutate<T>(operation: (state: CredentialFile) => T): Promise<T> {
    let result!: T;
    const run = this.chain.then(async () => {
      const state = await this.load();
      result = operation(state);
      // Expired, consumed pairings are useless after a write; drop them.
      const now = Date.now();
      state.pairings = state.pairings.filter((pairing) => !pairing.consumedAt && Date.parse(pairing.expiresAt) > now);
      await writeJsonAtomic(this.path, state);
    });
    this.chain = run.catch(() => undefined);
    await run;
    return result;
  }

  async findDeviceByTokenHash(tokenHash: string): Promise<DeviceRecord | null> {
    const state = await this.load();
    return state.devices.find((device) => device.tokenHash === tokenHash) ?? null;
  }
  async saveDevice(record: DeviceRecord): Promise<void> {
    await this.mutate((state) => {
      state.devices = [...state.devices.filter((device) => device.deviceId !== record.deviceId), record];
    });
  }
  async touchDevice(deviceId: string, seenAt: string): Promise<void> {
    const state = await this.load();
    const device = state.devices.find((candidate) => candidate.deviceId === deviceId);
    // Last-seen is informational; it does not need a synchronous write per connection.
    if (device) device.lastSeenAt = seenAt;
  }
  async revokeDevice(deviceId: string, revokedAt: string): Promise<boolean> {
    return this.mutate((state) => {
      const device = state.devices.find((candidate) => candidate.deviceId === deviceId);
      if (!device || device.revokedAt) return false;
      device.revokedAt = revokedAt;
      return true;
    });
  }
  async listDevices(): Promise<DeviceRecord[]> {
    return [...(await this.load()).devices];
  }
  async findPairing(tokenHash: string): Promise<PairingRecord | null> {
    const state = await this.load();
    return state.pairings.find((pairing) => pairing.tokenHash === tokenHash) ?? null;
  }
  async savePairing(record: PairingRecord): Promise<void> {
    await this.mutate((state) => {
      state.pairings = [...state.pairings.filter((pairing) => pairing.tokenHash !== record.tokenHash), record];
    });
  }
  async consumePairing(tokenHash: string, consumedAt: string): Promise<boolean> {
    return this.mutate((state) => {
      const pairing = state.pairings.find((candidate) => candidate.tokenHash === tokenHash);
      if (!pairing || pairing.consumedAt) return false;
      pairing.consumedAt = consumedAt;
      return true;
    });
  }
}
