import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { hostname } from "node:os";
import type { SessionManager } from "@earendil-works/pi-coding-agent";

export type NativePiSnapshot = {
  bytes: Buffer;
  hash: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  validJsonl: boolean;
  leafId: string | null;
};

type LeaseRecord = {
  token: string;
  pid: number;
  hostname: string;
  target: Pick<NativePiSnapshot, "dev" | "ino" | "size" | "hash" | "leafId">;
};

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function nativePiSnapshot(path: string): NativePiSnapshot {
  const stats = statSync(path);
  const bytes = readFileSync(path);
  let leafId: string | null = null;
  let validJsonl = true;
  let parsedLines = 0;
  for (const line of bytes.toString("utf8").trimEnd().split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (parsedLines === 0 && entry?.type !== "session") validJsonl = false;
      parsedLines += 1;
      if (entry?.type !== "session" && typeof entry?.id === "string") leafId = entry.id;
    } catch {
      validJsonl = false;
    }
  }
  return {
    bytes,
    hash: hash(bytes),
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    validJsonl,
    leafId,
  };
}

function isCompleteAppendOnlyExtension(
  previous: LeaseRecord["target"],
  current: NativePiSnapshot,
): boolean {
  if (
    previous.dev !== current.dev ||
    previous.ino !== current.ino ||
    current.size < previous.size ||
    hash(current.bytes.subarray(0, previous.size)) !== previous.hash ||
    current.bytes.at(-1) !== 0x0a
  ) {
    return false;
  }
  let parentId = previous.leafId;
  const suffix = current.bytes.subarray(previous.size).toString("utf8").trimEnd();
  if (!suffix) return true;
  for (const line of suffix.split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (typeof entry?.id !== "string" || entry.parentId !== parentId) return false;
      parentId = entry.id;
    } catch {
      return false;
    }
  }
  return true;
}

function sameSnapshot(a: NativePiSnapshot, b: NativePiSnapshot): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.hash === b.hash;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Cooperative PI-Desktop lease plus optimistic file validation.
 * Native Pi clients do not yet share this lock, so every SDK append is also
 * guarded by a byte fingerprint and fails closed on foreign changes.
 */
export class NativePiSessionLease {
  private expected: NativePiSnapshot;
  private readonly lockPath: string;
  private readonly token = randomUUID();
  private released = false;

  private constructor(
    private readonly path: string,
    expected: NativePiSnapshot,
  ) {
    this.expected = expected;
    this.lockPath = `${path}.pi-desktop.lock`;
  }

  static acquire(path: string, expected: NativePiSnapshot): NativePiSessionLease {
    const lease = new NativePiSessionLease(path, expected);
    lease.createLock(true);
    return lease;
  }

  static canAcquire(path: string, current: NativePiSnapshot): boolean {
    try {
      const previous = JSON.parse(readFileSync(`${path}.pi-desktop.lock`, "utf8")) as LeaseRecord;
      return previous?.hostname === hostname() && !processIsAlive(previous.pid) &&
        Boolean(previous.target) && isCompleteAppendOnlyExtension(previous.target, current);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  private record(): LeaseRecord {
    return {
      token: this.token,
      pid: process.pid,
      hostname: hostname(),
      target: {
        dev: this.expected.dev,
        ino: this.expected.ino,
        size: this.expected.size,
        hash: this.expected.hash,
        leafId: this.expected.leafId,
      },
    };
  }

  private createLock(allowStaleReclaim: boolean): void {
    try {
      const fd = openSync(
        this.lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        writeFileSync(fd, `${JSON.stringify(this.record())}\n`, "utf8");
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !allowStaleReclaim) {
        throw Object.assign(new Error("Native Pi session is already open for writing"), {
          errorCode: "NATIVE_PI_SESSION_BUSY",
        });
      }
      if (!NativePiSessionLease.canAcquire(this.path, nativePiSnapshot(this.path))) {
        throw Object.assign(new Error("Native Pi session is already open for writing"), {
          errorCode: "NATIVE_PI_SESSION_BUSY",
        });
      }
      try {
        unlinkSync(this.lockPath);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw Object.assign(new Error("Native Pi session is already open for writing"), {
            errorCode: "NATIVE_PI_SESSION_BUSY",
          });
        }
      }
      this.createLock(false);
    }
  }

  assertUnchanged(): void {
    let ownsLock = false;
    try {
      ownsLock = JSON.parse(readFileSync(this.lockPath, "utf8"))?.token === this.token;
    } catch { /* Missing or uncertain ownership fails closed. */ }
    if (!ownsLock || this.released || !sameSnapshot(this.expected, nativePiSnapshot(this.path))) {
      throw Object.assign(
        new Error("Native Pi session changed in another client; reload before continuing"),
        { errorCode: "NATIVE_PI_SESSION_CHANGED" },
      );
    }
  }

  acceptOwnAppend(entryId: string, parentId: string | null): void {
    const next = nativePiSnapshot(this.path);
    const suffix = next.bytes.subarray(this.expected.bytes.length).toString("utf8");
    let appended: any;
    try {
      appended = JSON.parse(suffix.trimEnd());
    } catch {
      // Fall through to the same fail-closed result as a foreign/interleaved append.
    }
    if (
      !next.bytes.subarray(0, this.expected.bytes.length).equals(this.expected.bytes) ||
      suffix.trimEnd().includes("\n") ||
      appended?.id !== entryId ||
      appended?.parentId !== parentId
    ) {
      throw Object.assign(
        new Error("Native Pi session changed while appending; reload before continuing"),
        { errorCode: "NATIVE_PI_SESSION_CHANGED" },
      );
    }
    this.expected = next;
    writeFileSync(this.lockPath, `${JSON.stringify(this.record())}\n`, { mode: 0o600 });
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    try {
      const record = JSON.parse(readFileSync(this.lockPath, "utf8")) as LeaseRecord;
      if (record.token === this.token) unlinkSync(this.lockPath);
    } catch {
      // Never remove an ownership record that cannot be proven to be ours.
    }
  }
}

export function acquireNativePiSessionLease(path: string): NativePiSessionLease {
  return NativePiSessionLease.acquire(path, nativePiSnapshot(path));
}

export function guardNativePiSessionManager(
  manager: SessionManager,
  lease: NativePiSessionLease,
  onMessage: (message: object, entryId: string) => void = () => undefined,
): void {
  const names = [
    "appendMessage",
    "appendThinkingLevelChange",
    "appendModelChange",
    "appendCompaction",
    "appendCustomEntry",
    "appendSessionInfo",
    "appendCustomMessageEntry",
    "appendContextEdit",
    "appendLabelChange",
    "branchWithSummary",
  ] as const;
  for (const name of names) {
    const original = (manager as any)[name].bind(manager);
    (manager as any)[name] = (...args: unknown[]) => {
      lease.assertUnchanged();
      const parentId = manager.getLeafId();
      const entryId = original(...args) as string;
      lease.acceptOwnAppend(entryId, parentId);
      if (name === "appendMessage" && args[0] && typeof args[0] === "object") {
        onMessage(args[0] as object, entryId);
      }
      return entryId;
    };
  }
}
