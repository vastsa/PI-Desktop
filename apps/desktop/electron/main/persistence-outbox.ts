import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostProcess } from "./host-process";

type MessageAppend = {
  key: string;
  sessionId: string;
  message: unknown;
  turnId?: string;
};

type OutboxLogger = (level: "warn" | "error", message: string, data?: unknown) => void;

const MAX_ENTRIES = 1024;

/**
 * Keeps transcript appends away from a dead host pipe. The file is an
 * application-owned outbox, while SQLite remains exclusively host-owned.
 * Message ids make replay idempotent after a host restart.
 */
export class PersistenceOutbox {
  private readonly path: string;
  private readonly tempPath: string;
  private readonly logger: OutboxLogger;
  private entries: MessageAppend[] = [];
  private flushing: Promise<void> | null = null;
  private persistChain = Promise.resolve();
  private readonly loaded: Promise<void>;

  constructor(dataDir: string, logger: OutboxLogger) {
    this.path = join(dataDir, "session-message-outbox.json");
    this.tempPath = `${this.path}.tmp`;
    this.logger = logger;
    this.loaded = this.load();
  }

  async enqueue(
    entry: MessageAppend,
    getHost: () => HostProcess | null,
  ): Promise<void> {
    await this.loaded;
    const existing = this.entries.findIndex((item) => item.key === entry.key);
    if (existing >= 0) this.entries[existing] = entry;
    else if (this.entries.length >= MAX_ENTRIES) {
      this.logger("error", "session persistence outbox is full", {
        size: this.entries.length,
        max: MAX_ENTRIES,
      });
      return;
    } else this.entries.push(entry);
    await this.persist();
    void this.flush(getHost);
  }

  async flush(getHost: () => HostProcess | null): Promise<void> {
    await this.loaded;
    if (this.flushing) return this.flushing;
    this.flushing = this.flushLoop(getHost).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /**
   * Drop queued appends for a session that the user deleted so a later
   * host-side stub recreate cannot resurrect it (D318).
   */
  async dropSession(sessionId: string): Promise<void> {
    await this.loaded;
    const next = this.entries.filter((entry) => entry.sessionId !== sessionId);
    if (next.length === this.entries.length) return;
    this.entries = next;
    await this.persist();
  }

  size(): number {
    return this.entries.length;
  }

  private async flushLoop(getHost: () => HostProcess | null): Promise<void> {
    while (this.entries.length > 0) {
      const current = this.entries[0];
      const currentHost = getHost();
      if (!currentHost || !currentHost.isAvailable()) return;
      try {
        await currentHost.call("session.appendMessage", {
          sessionId: current.sessionId,
          message: current.message,
          turnId: current.turnId,
        });
      } catch (error) {
        this.logger("warn", "session persistence flush paused", {
          key: current.key,
          data: String(error),
        });
        return;
      }
      this.entries.shift();
      await this.persist();
    }
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.entries = parsed.filter((entry): entry is MessageAppend => {
          return (
            entry &&
            typeof entry.key === "string" &&
            typeof entry.sessionId === "string" &&
            "message" in entry
          );
        });
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        this.logger("warn", "session persistence outbox load failed", String(error));
      }
    }
  }

  private async persist(): Promise<void> {
    const write = this.persistChain.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      if (this.entries.length === 0) {
        try {
          await writeFile(this.path, "[]\n", "utf8");
        } catch (error) {
          this.logger("warn", "session persistence outbox clear failed", String(error));
        }
        return;
      }
      await writeFile(this.tempPath, `${JSON.stringify(this.entries)}\n`, "utf8");
      await rename(this.tempPath, this.path);
    });
    this.persistChain = write.catch(() => undefined);
    await write;
  }
}
