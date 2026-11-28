import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { join } from "node:path";
import type { LanDevice } from "@pi-desktop/shared";

export const MAX_DEVICES = 16;
export const LABEL_MAX = 60;

export type LanBinding = { address: string; port: number };
export type LanPairedDevice = LanDevice & { tokenHash: string; expiresAt: number };
export type LanSavedState = {
  enabled: boolean;
  binding: LanBinding | null;
  devices: readonly LanPairedDevice[];
};

const emptyState: LanSavedState = { enabled: false, binding: null, devices: [] };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);

function parseBinding(value: unknown): LanBinding | null {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.address !== "string" || !isIPv4(value.address)
    || !isSafeInteger(value.port) || value.port < 1 || value.port > 65_535) {
    throw new Error("Invalid saved LAN WebUI binding");
  }
  return { address: value.address, port: value.port };
}

function parseDevice(value: unknown): LanPairedDevice {
  if (!isRecord(value) || typeof value.id !== "string" || !/^[0-9a-f-]{36}$/.test(value.id)
    || typeof value.label !== "string" || !value.label.length || value.label.length > LABEL_MAX
    || typeof value.tokenHash !== "string" || !/^[0-9a-f]{64}$/.test(value.tokenHash)
    || !isSafeInteger(value.lastActiveAt) || !isSafeInteger(value.expiresAt) || value.expiresAt <= value.lastActiveAt) {
    throw new Error("Invalid saved LAN WebUI device");
  }
  return { id: value.id, label: value.label, tokenHash: value.tokenHash, lastActiveAt: value.lastActiveAt, expiresAt: value.expiresAt };
}

function decode(value: unknown): LanSavedState {
  if (!isRecord(value) || value.version !== 1 || typeof value.enabled !== "boolean"
    || !Array.isArray(value.devices) || value.devices.length > MAX_DEVICES) {
    throw new Error("Invalid saved LAN WebUI state");
  }
  const binding = parseBinding(value.binding);
  if (!value.enabled) return { enabled: false, binding, devices: [] };
  if (!binding) throw new Error("Missing saved LAN WebUI binding");
  const devices = value.devices.map(parseDevice);
  if (new Set(devices.map(({ id }) => id)).size !== devices.length
    || new Set(devices.map(({ tokenHash }) => tokenHash)).size !== devices.length) {
    throw new Error("Duplicate saved LAN WebUI devices");
  }
  return { enabled: true, binding, devices };
}

/** Machine-local listener intent and cookie verifiers, never synced or exported through IPC. */
export function createLanStateStore(dataDir: string) {
  const path = join(dataDir, "lan-webui.json");
  return {
    read(): LanSavedState {
      let source: string;
      try {
        source = readFileSync(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState;
        throw error;
      }
      return decode(JSON.parse(source));
    },
    write(state: LanSavedState): void {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        // The file is bounded to a handful of records. Commit it before accepting
        // a pairing or acknowledging a revocation, with no async mutation gap.
        writeFileSync(temporary, JSON.stringify({ version: 1, ...state }), { mode: 0o600, flag: "wx", flush: true });
        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
  };
}
