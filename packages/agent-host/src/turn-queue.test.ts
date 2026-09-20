import { describe, expect, it } from "vitest";

import { RacpError } from "./errors.js";
import { MemoryQueueStore, type QueueStore, type QueuedTurnRecord } from "./ports.js";
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
    await store.push({ ...record("late", "s1", 5), sessionMessageId: "message-late" });
    await store.push(record("early", "s1", 1));
    await store.push(record("other", "s2", 3));
    const queue = new TurnQueue(store, 8);
    expect(await queue.restore()).toBe(3);
    expect(queue.list("s1").map((entry) => entry.id)).toEqual(["early", "late"]);
    expect(queue.find("late")?.sessionMessageId).toBe("message-late");
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

  it("promotes entries to the end of the priority block in click order", async () => {
    const promoted: string[] = [];
    const store: QueueStore = {
      listAll: async () => [],
      push: async () => {},
      remove: async () => true,
      prioritize: async (id) => {
        promoted.push(id);
      },
    };
    const queue = new TurnQueue(store, 8);
    await queue.push(record("one"));
    await queue.push(record("two", "s1", 2));
    await queue.push(record("three", "s1", 3));
    expect(await queue.promote("s1", "one")).toBe(true);
    expect(await queue.promote("s1", "three")).toBe(true);
    expect(promoted).toEqual(["one", "three"]);
    // The first click leaves first; the plain entry stays behind both.
    expect(queue.list("s1").map((entry) => entry.id)).toEqual(["one", "three", "two"]);
    expect(queue.list("s1").map((entry) => entry.priority)).toEqual([1, 2, undefined]);
    // Promotion is one-way.
    expect(await queue.promote("s1", "one")).toBe(false);
    expect(await queue.promote("s1", "missing")).toBe(false);
    expect(queue.list("s1").map((entry) => entry.id)).toEqual(["one", "three", "two"]);
  });

  it("reorders a plain entry against its adjacent non-prioritized neighbour", async () => {
    const calls: Array<[string, string]> = [];
    const store: QueueStore = {
      listAll: async () => [],
      push: async () => {},
      remove: async () => true,
      reorder: async (id, direction) => {
        calls.push([id, direction]);
        return true;
      },
    };
    const queue = new TurnQueue(store, 8);
    await queue.push(record("one"));
    await queue.push(record("two", "s1", 2));
    await queue.push(record("three", "s1", 3));
    expect(await queue.reorder("s1", "one", "up")).toBe(false);
    expect(await queue.reorder("s1", "three", "up")).toBe(true);
    expect(queue.list("s1").map((entry) => entry.id)).toEqual(["one", "three", "two"]);
    expect(await queue.reorder("s1", "two", "down")).toBe(false);
    expect(await queue.reorder("s1", "missing", "up")).toBe(false);
    expect(await queue.reorder("s1", "three", "down")).toBe(true);
    expect(queue.list("s1").map((entry) => entry.id)).toEqual(["one", "two", "three"]);
    expect(calls).toEqual([
      ["three", "up"],
      ["three", "down"],
    ]);
  });

  it("never reorders a promoted entry and skips it as a neighbour", async () => {
    const queue = new TurnQueue(new MemoryQueueStore(), 8);
    await queue.push(record("one"));
    await queue.push(record("two", "s1", 2));
    await queue.push(record("three", "s1", 3));
    expect(await queue.promote("s1", "three")).toBe(true);
    expect(queue.list("s1").map((entry) => entry.id)).toEqual(["three", "one", "two"]);
    expect(await queue.reorder("s1", "three", "down")).toBe(false);
    expect(queue.list("s1").map((entry) => entry.id)).toEqual(["three", "one", "two"]);
    expect(await queue.reorder("s1", "one", "up")).toBe(false);
    expect(await queue.reorder("s1", "one", "down")).toBe(true);
    expect(queue.list("s1").map((entry) => entry.id)).toEqual(["three", "two", "one"]);
  });

  it("restores the priority block ahead of the plain queue", async () => {
    const store: QueueStore = {
      listAll: async () => [
        record("plain", "s1", 1),
        { ...record("clicked", "s1", 2), priority: 1 },
        { ...record("clicked-later", "s1", 3), priority: 2 },
      ],
      push: async () => {},
      remove: async () => true,
    };
    const queue = new TurnQueue(store, 8);
    expect(await queue.restore()).toBe(3);
    expect(queue.list("s1").map((entry) => entry.id)).toEqual(["clicked", "clicked-later", "plain"]);
    expect(queue.isHeld("s1")).toBe(true);
  });
});
