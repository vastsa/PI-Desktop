import { describe, expect, it } from "vitest";

import { RacpError } from "./errors.js";
import { MemoryQueueStore, type QueuedTurnRecord } from "./ports.js";
import { TurnQueue } from "./turn-queue.js";

function record(id: string, sessionId = "s1", createdAt = 1): QueuedTurnRecord {
  return {
    id,
    sessionId,
    principalSubject: "user",
    content: `prompt ${id}`,
    effectivePermissionMode: "ask",
    inputHash: id,
    createdAt,
  };
}

describe("TurnQueue", () => {
  it("keeps arrival order, positions, and the per-session bound", async () => {
    const queue = new TurnQueue(new MemoryQueueStore(), 2);
    expect(await queue.push(record("a"))).toBe(1);
    expect(await queue.push(record("b", "s1", 2))).toBe(2);
    expect(queue.position("s1", "b")).toBe(2);
    await expect(queue.push(record("c", "s1", 3))).rejects.toMatchObject({
      code: "AGENT_BUSY",
      details: { queueFull: true },
    });
    expect(queue.peek("s1")?.id).toBe("a");
    expect((await queue.shift("s1"))?.id).toBe("a");
    expect(queue.position("s1", "b")).toBe(1);
    expect(await queue.remove("s1", "missing")).toBeUndefined();
    expect((await queue.remove("s1", "b"))?.id).toBe("b");
    expect(queue.size("s1")).toBe(0);
  });

  it("restores persisted records held until a controller resumes them", async () => {
    const store = new MemoryQueueStore();
    await store.push(record("late", "s1", 5));
    await store.push(record("early", "s1", 1));
    await store.push(record("other", "s2", 3));
    const queue = new TurnQueue(store, 8);
    expect(await queue.restore()).toBe(3);
    expect(queue.list("s1").map((entry) => entry.id)).toEqual(["early", "late"]);
    expect(queue.isHeld("s1")).toBe(true);
    expect(queue.isHeld("s2")).toBe(true);
    expect(queue.isHeld("s3")).toBe(false);
    queue.resume("s1");
    expect(queue.isHeld("s1")).toBe(false);
    expect(queue.find("other")?.sessionId).toBe("s2");
  });

  it("raises RacpError instances", async () => {
    const queue = new TurnQueue(new MemoryQueueStore(), 0);
    await expect(queue.push(record("a"))).rejects.toBeInstanceOf(RacpError);
  });
});
