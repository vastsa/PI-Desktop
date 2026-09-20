/**
 * Persisted list of paired remote hosts. Each record binds one host key to
 * the URL of its RACP-WS endpoint and the encrypted device token the host
 * issued during pairing. The file lives at `<dataDir>/remote-hosts.json` and
 * the token bytes are encrypted with Electron's `safeStorage` before write;
 * on read they decrypt back through the same interface, so a stolen file
 * without OS keychain access reveals only the URL and label.
 *
 * The registry is injected with an {@link EncryptionPort} rather than
 * imported from `electron` so it stays unit-testable in `node --test`; the
 * boot layer wires the real `safeStorage.encryptString` /
 * `safeStorage.decryptString` pair.
 */
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Byte-in, byte-out encryption. `encryptString` returns a Buffer of
 * ciphertext; `decryptString` recovers the plaintext from the same bytes.
 * Both throw when the underlying keychain is unavailable — the registry
 * surfaces the failure to the caller.
 */
export interface EncryptionPort {
  isAvailable(): boolean;
  encryptString(plaintext: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

/** One paired host as it lives on disk (every secret stays encrypted at rest). */
export type RemoteHostRecord = {
  /** Stable id used in `remote:<hostKey>:<...>` renderer session ids. */
  hostKey: string;
  /** Human label; shown in a future host list. */
  label: string;
  /** `ws://…` or `wss://…` URL for the RACP endpoint. */
  url: string;
  /** Device token issued at pairing, presented on every reconnect. */
  deviceToken: string;
  /**
   * SSH login password for a host that authenticates with one instead of a
   * key. Optional and normally absent. It is the second encrypted-at-rest
   * value in the record and, unlike `metadata`, it is never handed to the
   * renderer — the only consumers are the tunnel's `ssh` spawn and the
   * bootstrap that is about to write it.
   */
  sshSecret?: string;
  /** Room for later fields (roles, protocol hints) without a schema bump. */
  metadata?: Record<string, unknown>;
};

/** The on-disk record: the plaintext secrets are replaced with base64
 * ciphertext + version byte, so neither can be recovered without the matching
 * safeStorage keychain. */
type SerializedRecord = {
  hostKey: string;
  label: string;
  url: string;
  /** Base64 of the `safeStorage.encryptString` output. */
  encryptedDeviceToken: string;
  /**
   * Base64 of the encrypted SSH password. Absent for a key-authenticated host
   * and for every record written before password auth existed, so the file
   * format needs no version bump.
   */
  encryptedSshSecret?: string;
  metadata?: Record<string, unknown>;
};

type SerializedFile = {
  version: 1;
  hosts: SerializedRecord[];
};

export type RemoteHostRegistryOptions = {
  dataDir: string;
  encryption: EncryptionPort;
  /** File name inside `dataDir`; defaults to `remote-hosts.json`. */
  fileName?: string;
  /** Optional structured log for I/O and decrypt failures. */
  log?: (level: "warn" | "error", message: string, data?: unknown) => void;
};

export interface RemoteHostRegistry {
  /** Every host record on disk with a decryptable token, in file order. */
  list(): Promise<RemoteHostRecord[]>;
  /** Add or replace the record for `record.hostKey` and flush. */
  upsert(record: RemoteHostRecord): Promise<void>;
  /** Remove one host key; a missing key is a no-op. */
  remove(hostKey: string): Promise<void>;
}

const CURRENT_VERSION = 1;

function fileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

export function createRemoteHostRegistry(
  options: RemoteHostRegistryOptions,
): RemoteHostRegistry {
  const log = options.log ?? (() => undefined);
  const filePath = join(options.dataDir, options.fileName ?? "remote-hosts.json");

  const readFileContents = async (): Promise<SerializedFile> => {
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SerializedFile>;
      if (parsed.version !== CURRENT_VERSION || !Array.isArray(parsed.hosts)) {
        log("warn", "remote-hosts.json shape rejected; treating as empty", { file: filePath });
        return { version: CURRENT_VERSION, hosts: [] };
      }
      return { version: CURRENT_VERSION, hosts: parsed.hosts };
    } catch (error) {
      if (fileNotFound(error)) return { version: CURRENT_VERSION, hosts: [] };
      log("error", "remote-hosts.json read failed", { error: String(error) });
      // A corrupt file must not delete records the user cannot see; the
      // caller reads an empty list and any upsert would overwrite it.
      return { version: CURRENT_VERSION, hosts: [] };
    }
  };

  const persist = async (file: SerializedFile): Promise<void> => {
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    // atomic replace — a crash leaves either the old file or the new one, never a torn write
    await rename(tmp, filePath);
  };

  return {
    async list() {
      const file = await readFileContents();
      const decoded: RemoteHostRecord[] = [];
      for (const record of file.hosts) {
        try {
          const buffer = Buffer.from(record.encryptedDeviceToken, "base64");
          const deviceToken = options.encryption.decryptString(buffer);
          // A host whose SSH password will not decrypt still has a usable
          // device token, and dropping the whole record over it would hide a
          // paired host from the user. It reads back as "no password", which
          // is exactly the pre-password-auth behaviour.
          let sshSecret: string | undefined;
          if (record.encryptedSshSecret) {
            try {
              sshSecret = options.encryption.decryptString(
                Buffer.from(record.encryptedSshSecret, "base64"),
              );
            } catch (error) {
              log("warn", "remote host ssh credential could not be decrypted; dropping it", {
                hostKey: record.hostKey,
                error: String(error),
              });
            }
          }
          decoded.push({
            hostKey: record.hostKey,
            label: record.label,
            url: record.url,
            deviceToken,
            ...(sshSecret !== undefined ? { sshSecret } : {}),
            ...(record.metadata ? { metadata: record.metadata } : {}),
          });
        } catch (error) {
          // A record we cannot decrypt (keychain moved, wrong OS user) is
          // dropped from the return: exposing an empty string as the token
          // would just cause auth failures downstream and the caller has no
          // way to distinguish that from a real revocation.
          log("warn", "remote host record could not be decrypted; skipping", {
            hostKey: record.hostKey,
            error: String(error),
          });
        }
      }
      return decoded;
    },
    async upsert(record) {
      if (!options.encryption.isAvailable()) {
        throw Object.assign(new Error("safeStorage unavailable; refusing to write remote host token"), {
          errorCode: "REMOTE_STORAGE_UNAVAILABLE",
        });
      }
      const file = await readFileContents();
      const ciphertext = options.encryption.encryptString(record.deviceToken).toString("base64");
      const serialized: SerializedRecord = {
        hostKey: record.hostKey,
        label: record.label,
        url: record.url,
        encryptedDeviceToken: ciphertext,
        ...(record.sshSecret
          ? {
              encryptedSshSecret: options.encryption
                .encryptString(record.sshSecret)
                .toString("base64"),
            }
          : {}),
        ...(record.metadata ? { metadata: record.metadata } : {}),
      };
      const next = file.hosts.filter((existing) => existing.hostKey !== record.hostKey);
      next.push(serialized);
      await persist({ version: CURRENT_VERSION, hosts: next });
    },
    async remove(hostKey) {
      const file = await readFileContents();
      const next = file.hosts.filter((existing) => existing.hostKey !== hostKey);
      if (next.length === file.hosts.length) return;
      if (next.length === 0) {
        try {
          await unlink(filePath);
        } catch (error) {
          if (!fileNotFound(error)) log("warn", "remote-hosts.json unlink failed", { error: String(error) });
        }
        return;
      }
      await persist({ version: CURRENT_VERSION, hosts: next });
    },
  };
}
