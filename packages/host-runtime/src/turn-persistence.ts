import { ErrorCodes, type UiMessage } from "@pi-desktop/shared";

import type { HostRpc } from "./host-ports.js";

export type TurnPersistenceLogger = (
  level: "warn" | "error",
  message: string,
  data?: Record<string, unknown>,
) => void;

export type MessageAppend = {
  sessionId: string;
  message: UiMessage;
  turnId?: string;
};

type HostAvailability = HostRpc & { isAvailable?(): boolean };

/** Bounded wait between retries while host-core is restarting. */
const RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000, 4_000, 8_000] as const;

function isHostUnavailable(error: unknown): boolean {
  return (error as { errorCode?: string } | null)?.errorCode === ErrorCodes.HOST_UNAVAILABLE;
}

function isDuplicateMessageIdError(error: unknown): boolean {
  return /UNIQUE constraint failed: messages\.id/i.test(String(error));
}

/**
 * Transcript appends for the headless Host. Rows of one session are written
 * in order, a write that only failed because host-core was restarting is
 * retried with a bounded backoff, and a duplicate message id counts as
 * written (the host already has the row). The queue is process memory: the
 * desktop keeps a file-backed outbox because a window can close mid-turn,
 * whereas a `pi-host` process ends only with its supervisor.
 */
export class TurnPersistence {
  private readonly chains = new Map<string, Promise<void>>();
  private pendingCount = 0;
  private disposed = false;

  constructor(
    private readonly deps: {
      getHost: () => HostAvailability | null;
      log: TurnPersistenceLogger;
      sleep?: (ms: number) => Promise<void>;
    },
  ) {}

  /** Number of appends not yet acknowledged by host-core. */
  size(): number {
    return this.pendingCount;
  }

  /** Queue one append behind the session's earlier ones; resolves once it landed or was given up. */
  append(entry: MessageAppend): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.pendingCount += 1;
    const previous = this.chains.get(entry.sessionId) ?? Promise.resolve();
    const run = previous
      .then(() => this.write(entry))
      .finally(() => {
        this.pendingCount -= 1;
        if (this.chains.get(entry.sessionId) === run) this.chains.delete(entry.sessionId);
      });
    this.chains.set(entry.sessionId, run);
    return run;
  }

  /** Wait until every queued append has been attempted. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.chains.values()]);
  }

  dispose(): void {
    this.disposed = true;
  }

  private async write(entry: MessageAppend): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      if (this.disposed) return;
      const host = this.deps.getHost();
      if (host && (host.isAvailable?.() ?? true)) {
        try {
          await host.call("session.appendMessage", {
            sessionId: entry.sessionId,
            message: entry.message,
            ...(entry.turnId ? { turnId: entry.turnId } : {}),
          });
          return;
        } catch (error) {
          if (isDuplicateMessageIdError(error)) return;
          if (!isHostUnavailable(error)) {
            this.deps.log("warn", "transcript append failed", {
              sessionId: entry.sessionId,
              messageId: entry.message.id,
              error: String(error),
            });
            return;
          }
        }
      }
      const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
      if (attempt >= RETRY_DELAYS_MS.length * 2) {
        this.deps.log("error", "transcript append abandoned: host unavailable", {
          sessionId: entry.sessionId,
          messageId: entry.message.id,
        });
        return;
      }
      await (this.deps.sleep ?? defaultSleep)(delay);
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
