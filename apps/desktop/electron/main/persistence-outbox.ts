import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HostProcess } from "./host-process";
import type { Logger } from "./logger";

type MessageAppend = {
  key: string;
  sessionId: string;
  message: unknown;
  turnId?: string;
};

type OutboxLogger = (level: "warn" | "error", message: string, data?: unknown) => void;

const BACKLOG_WARNING_THRESHOLD = 1024;

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
  private readonly enqueuing = new Map<Promise<void>, string>();

  constructor(dataDir: string, logger: OutboxLogger) {
    this.path = join(dataDir, "session-message-outbox.json");
    this.tempPath = `${this.path}.tmp`;
    this.logger = logger;
    this.loaded = this.load();
  }

  enqueue(entry: MessageAppend, getHost: () => HostProcess | null): Promise<void> {
    // Reserve synchronously: a terminal event can follow before load or disk I/O settles.
    const pending = this.enqueueEntry(entry, getHost).finally(() => this.enqueuing.delete(pending));
    this.enqueuing.set(pending, entry.sessionId);
    return pending;
  }

  private async enqueueEntry(
    entry: MessageAppend,
    getHost: () => HostProcess | null,
  ): Promise<void> {
    await this.loaded;
    const existing = this.entries.findIndex((item) => item.key === entry.key);
    if (existing >= 0) this.entries[existing] = entry;
    else {
      // Completed messages must remain recoverable until the host acknowledges them.
      // Persist overflow in the same recovery file instead of acknowledging a
      // dropped row. Turn settlement prevents subsequent prompts from adding
      // work in this session until its backlog reaches the host.
      if (this.entries.length === BACKLOG_WARNING_THRESHOLD) {
        this.logger("warn", "session persistence outbox backlog is high", {
          size: this.entries.length,
          threshold: BACKLOG_WARNING_THRESHOLD,
        });
      }
      this.entries.push(entry);
    }
    await this.persist();
    void this.flush(getHost);
  }

  async flush(getHost: () => HostProcess | null, sessionId?: string): Promise<void> {
    await this.loaded;
    while (this.flushing) await this.flushing;
    const pending = this.flushLoop(getHost, sessionId);
    this.flushing = pending;
    try {
      await pending;
    } finally {
      if (this.flushing === pending) this.flushing = null;
    }
  }

  /** Hold turn ownership until its transcript is durable; quit leaves the outbox for restart. */
  async drainSession(
    sessionId: string,
    getHost: () => HostProcess | null,
    isStopping: () => boolean,
  ): Promise<boolean> {
    await this.loaded;
    for (;;) {
      if (isStopping()) return false;
      try {
        const pending = [...this.enqueuing].filter(([, id]) => id === sessionId).map(([write]) => write);
        await Promise.all(pending);
        await this.flush(getHost, sessionId);
        if (!this.entries.some((entry) => entry.sessionId === sessionId) &&
            ![...this.enqueuing.values()].includes(sessionId)) return true;
      } catch (error) {
        // A failed local write must not release the next prompt either.
        this.logger("warn", "session transcript settlement retrying", { sessionId, error: String(error) });
      }
      // This finalization owns the retry timer. It cannot keep the process alive;
      // shutdown ends the wait on the next iteration and preserves unsaved rows.
      await new Promise<void>((resolve) => { setTimeout(resolve, 1000).unref(); });
    }
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

  private async flushLoop(getHost: () => HostProcess | null, sessionId?: string): Promise<void> {
    for (;;) {
      const current = this.entries.find((entry) => sessionId === undefined || entry.sessionId === sessionId);
      if (!current) return;
      const currentHost = getHost();
      if (!currentHost || !currentHost.isAvailable()) return;
      try {
        await currentHost.call("session.appendMessage", {
          sessionId: current.sessionId,
          message: current.message,
          turnId: current.turnId,
        });
      } catch (error) {
        // A duplicate message id means the host already has the row; drop it
        // and keep draining (D318/#560).
        if (isDuplicateMessageIdError(error)) {
          this.logger("warn", "session persistence flush skipped duplicate message id", {
            key: current.key,
            data: String(error),
          });
        } else if (isPoisonMessageError(error)) {
          // The host will reject this row forever (provenance / permission
          // on this message). Drop only this entry and keep draining so one
          // poisoned head cannot starve later transcript rows (D597).
          this.logger("warn", "session persistence flush dropped poisoned message", {
            key: current.key,
            data: String(error),
          });
        } else {
          // Transient failure (host busy/overloaded/pipe dead). Keep the head
          // and retry on the next enqueue.
          this.logger("warn", "session persistence flush paused", {
            key: current.key,
            data: String(error),
          });
          return;
        }
      }
      // A newer snapshot may have replaced this key while the host wrote it.
      // Only remove the exact entry acknowledged by that write.
      const index = this.entries.indexOf(current);
      if (index >= 0) this.entries.splice(index, 1);
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

function isDuplicateMessageIdError(error: unknown): boolean {
  return /UNIQUE constraint failed: messages\.id/i.test(String(error));
}

/**
 * The host will reject this message on every retry. Match the host-core
 * provenance prefix in the JSON-RPC message body (append maps those failures
 * as INTERNAL). Do not treat PLUGIN_PERMISSION_DENIED or schema
 * INVALID_PARAMS as poison — those are a different surface, and serde
 * failures do not even put INVALID_PARAMS in the message text.
 */
function isPoisonMessageError(error: unknown): boolean {
  return /(?<![A-Z_])PERMISSION_DENIED:/i.test(String(error));
}

export function createPersistenceRuntime(
  dataDir: string,
  logger: Pick<Logger, "app">,
  getHost: () => HostProcess | null,
  isStopping: () => boolean,
) {
  const persistenceOutbox = new PersistenceOutbox(dataDir, (level, message, data) => {
    logger.app("persistence", level, message, { data });
  });
  const settleTranscript = (sessionId: string) =>
    persistenceOutbox.drainSession(sessionId, getHost, isStopping);
  return { persistenceOutbox, settleTranscript };
}
