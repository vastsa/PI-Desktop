import { racpError } from "./errors.js";
import type { QueueReorderDirection, QueueStore, QueuedTurnRecord } from "./ports.js";

/**
 * Delivery order: promoted entries first in click order (ascending `priority`),
 * then the remaining entries in arrival order. Equal entries keep their
 * current index, so the mirror never reshuffles what it cannot order.
 */
function orderQueue(records: QueuedTurnRecord[]): QueuedTurnRecord[] {
  return records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => {
      const left = a.record.priority;
      const right = b.record.priority;
      if (left === undefined && right === undefined) return a.index - b.index;
      if (left === undefined) return 1;
      if (right === undefined) return -1;
      return left - right || a.index - b.index;
    })
    .map((entry) => entry.record);
}

/** The next place in a session's priority block: promoted entries append. */
function nextPriority(records: QueuedTurnRecord[]): number {
  return records.reduce((highest, record) => Math.max(highest, record.priority ?? 0), 0) + 1;
}

/** Index of the adjacent neighbour that a reorder may swap with, or `-1`. */
function adjacentIndex(
  records: QueuedTurnRecord[],
  index: number,
  direction: QueueReorderDirection,
): number {
  const step = direction === "up" ? -1 : 1;
  for (let candidate = index + step; candidate >= 0 && candidate < records.length; candidate += step) {
    if (records[candidate]?.priority === undefined) return candidate;
  }
  return -1;
}

/**
 * The Host-owned per-session turn queue (spec §7.3, D375). Records are kept
 * in the injected store and mirrored in memory in delivery order: promoted
 * entries first in click order, then the rest in arrival order. A queue that
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
    // A store that only preserves arrival order still restores the priority
    // block first.
    for (const sessionId of this.bySession.keys()) {
      const queue = this.bySession.get(sessionId) ?? [];
      this.bySession.set(sessionId, orderQueue(queue));
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
    // A plain entry always lands after the priority block.
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

  /**
   * Promote one entry to the end of its session's priority block ("send now").
   * `false` when the entry is not queued or already promoted: promotion is
   * one-way, so the mirror never moves a promoted entry again.
   */
  async promote(sessionId: string, id: string): Promise<boolean> {
    const queue = this.bySession.get(sessionId);
    if (!queue) return false;
    const record = queue.find((candidate) => candidate.id === id);
    if (!record || record.priority !== undefined) return false;
    if (this.store.prioritize) await this.store.prioritize(id);
    record.priority = nextPriority(queue);
    this.bySession.set(sessionId, orderQueue(queue));
    return true;
  }

  /**
   * Swap one plain-queue entry with its adjacent non-prioritized neighbour.
   * `false` when the entry is missing, promoted, or already at that edge; a
   * promoted entry is never used as a neighbour.
   */
  async reorder(sessionId: string, id: string, direction: QueueReorderDirection): Promise<boolean> {
    const queue = this.bySession.get(sessionId);
    if (!queue) return false;
    const index = queue.findIndex((record) => record.id === id);
    if (index === -1 || queue[index]?.priority !== undefined) return false;
    const neighbourIndex = adjacentIndex(queue, index, direction);
    if (neighbourIndex === -1) return false;
    if (this.store.reorder && !(await this.store.reorder(id, direction))) return false;
    const current = queue[index];
    const neighbour = queue[neighbourIndex];
    if (!current || !neighbour) return false;
    queue[neighbourIndex] = current;
    queue[index] = neighbour;
    return true;
  }
}
