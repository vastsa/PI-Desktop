import { racpError } from "./errors.js";
import type { QueueStore, QueuedTurnRecord } from "./ports.js";

/**
 * The Host-owned per-session turn queue (spec §7.3, D375). Records are kept
 * in the injected store and mirrored in memory in arrival order. A queue that
 * was restored from the store starts held: release resumes only after a
 * controller attaches, so a reboot never starts work unattended.
 */
export class TurnQueue {
  private readonly bySession = new Map<string, QueuedTurnRecord[]>();
  private readonly held = new Set<string>();

  constructor(
    private readonly store: QueueStore,
    private readonly maxPerSession: number,
  ) {}

  /** Load persisted records and hold every session that has any. */
  async restore(): Promise<number> {
    const records = await this.store.listAll();
    this.bySession.clear();
    this.held.clear();
    for (const record of records) {
      const queue = this.bySession.get(record.sessionId) ?? [];
      queue.push(record);
      this.bySession.set(record.sessionId, queue);
      this.held.add(record.sessionId);
    }
    return records.length;
  }

  isHeld(sessionId: string): boolean {
    return this.held.has(sessionId);
  }

  /** A controller attached: the restored queue may drain again. */
  resume(sessionId: string): void {
    this.held.delete(sessionId);
  }

  list(sessionId: string): QueuedTurnRecord[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  size(sessionId: string): number {
    return this.bySession.get(sessionId)?.length ?? 0;
  }

  peek(sessionId: string): QueuedTurnRecord | undefined {
    return this.bySession.get(sessionId)?.[0];
  }

  position(sessionId: string, id: string): number | undefined {
    const index = (this.bySession.get(sessionId) ?? []).findIndex((record) => record.id === id);
    return index === -1 ? undefined : index + 1;
  }

  find(id: string): QueuedTurnRecord | undefined {
    for (const queue of this.bySession.values()) {
      const record = queue.find((candidate) => candidate.id === id);
      if (record) return record;
    }
    return undefined;
  }

  async push(record: QueuedTurnRecord): Promise<number> {
    const queue = this.bySession.get(record.sessionId) ?? [];
    if (queue.length >= this.maxPerSession) {
      throw racpError("AGENT_BUSY", "the session queue is full", {
        details: { queueFull: true, maxQueuedTurnsPerSession: this.maxPerSession },
      });
    }
    await this.store.push(record);
    queue.push(record);
    this.bySession.set(record.sessionId, queue);
    return queue.length;
  }

  async remove(sessionId: string, id: string): Promise<QueuedTurnRecord | undefined> {
    const queue = this.bySession.get(sessionId);
    if (!queue) return undefined;
    const index = queue.findIndex((record) => record.id === id);
    if (index === -1) return undefined;
    const [record] = queue.splice(index, 1);
    if (queue.length === 0) this.bySession.delete(sessionId);
    await this.store.remove(id);
    return record;
  }

  /** Take the head for execution. */
  async shift(sessionId: string): Promise<QueuedTurnRecord | undefined> {
    const head = this.peek(sessionId);
    if (!head) return undefined;
    return this.remove(sessionId, head.id);
  }

  /** Move one entry to the head ("send now"); `false` when it is not queued. */
  async moveToHead(sessionId: string, id: string): Promise<boolean> {
    const queue = this.bySession.get(sessionId);
    if (!queue) return false;
    const index = queue.findIndex((record) => record.id === id);
    if (index === -1) return false;
    if (this.store.prioritize) await this.store.prioritize(id);
    const [record] = queue.splice(index, 1);
    queue.unshift(record!);
    return true;
  }
}
