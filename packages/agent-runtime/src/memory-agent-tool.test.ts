import { describe, expect, it } from "vitest";
import {
  createMemoryTool,
  readMemoryOperations,
  renderMemoryResult,
} from "./memory-agent-tool.js";
import { ENTRY_DELIMITER } from "./memory-store.js";

describe("readMemoryOperations", () => {
  it("normalizes each single action", () => {
    expect(readMemoryOperations({ action: "add", content: "a note" })).toEqual({
      operations: [{ action: "add", content: "a note" }],
    });
    expect(readMemoryOperations({ action: "remove", old_text: "a note" })).toEqual({
      operations: [{ action: "remove", old_text: "a note" }],
    });
    expect(
      readMemoryOperations({ action: "patch", old_text: "tea", content: "coffee" }),
    ).toEqual({ operations: [{ action: "patch", old_text: "tea", content: "coffee" }] });
    expect(
      readMemoryOperations({ action: "replace", old_text: "tea", content: "coffee" }),
    ).toEqual({ operations: [{ action: "replace", old_text: "tea", content: "coffee" }] });
  });

  it("requires the fields each action needs", () => {
    expect(readMemoryOperations({ action: "add" })).toHaveProperty("error");
    expect(readMemoryOperations({ action: "patch", content: "x" })).toHaveProperty("error");
    expect(readMemoryOperations({ action: "remove" })).toHaveProperty("error");
    expect(readMemoryOperations({})).toHaveProperty("error");
    expect(readMemoryOperations({ action: "nonsense" })).toHaveProperty("error");
  });

  it("refuses a batch that is not an operations list", () => {
    expect(readMemoryOperations({ action: "batch" })).toHaveProperty("error");
    expect(readMemoryOperations({ operations: [] })).toHaveProperty("error");
  });

  it("refuses both an action and an operations list", () => {
    const result = readMemoryOperations({
      action: "add",
      operations: [{ action: "add", content: "x" }],
    });
    expect(result).toHaveProperty("error");
  });

  it("normalizes a batch and validates each operation", () => {
    expect(
      readMemoryOperations({
        operations: [
          { action: "remove", old_text: "stale" },
          { action: "add", content: "fresh" },
        ],
      }),
    ).toEqual({
      operations: [
        { action: "remove", old_text: "stale" },
        { action: "add", content: "fresh" },
      ],
    });
    const bad = readMemoryOperations({
      operations: [{ action: "remove", old_text: "stale" }, { action: "add" }],
    });
    expect(bad).toHaveProperty("error");
    expect((bad as { error: string }).error).toContain("operation 2");
  });
});

describe("renderMemoryResult", () => {
  it("echoes the new list, because the prompt snapshot is frozen", () => {
    const text = renderMemoryResult("memory", {
      success: true,
      message: "Entry added.",
      entries: ["one", "two"],
    });
    expect(text).toContain("Entry added.");
    expect(text).toContain("2 entries");
    expect(text).toContain(`one${ENTRY_DELIMITER}two`);
  });

  it("shows the budget in use", () => {
    const text = renderMemoryResult("user", {
      success: true,
      message: "Entry added.",
      entries: ["x".repeat(10)],
    });
    expect(text).toContain("/1375");
  });

  it("lists the closest entries when nothing matched", () => {
    const text = renderMemoryResult("memory", {
      success: false,
      error: "No entry matched 'tea'.",
      failureClass: "no_match",
      closestEntries: ["the user prefers coffee"],
    });
    expect(text).toContain("closest_entries:");
    expect(text).toContain("- the user prefers coffee");
  });

  it("lists current entries when the budget is exceeded", () => {
    const text = renderMemoryResult("memory", {
      success: false,
      error: "Would put memory at 3000/2200 chars",
      failureClass: "over_budget",
      currentEntries: ["a big entry"],
    });
    expect(text).toContain("current_entries:");
    expect(text).toContain("- a big entry");
  });
});

/** Minimal host that keeps one target's entries in memory. */
function fakeHost(initial: string[] = []) {
  const state = { entries: [...initial] };
  return {
    state,
    call: async <T>(method: string, params: unknown): Promise<T> => {
      const input = params as { target?: string; entries?: string[] };
      if (method === "memory.entries") {
        return { entries: [...state.entries] } as T;
      }
      if (method === "memory.writeEntries") {
        state.entries = [...(input.entries ?? [])];
        return { entries: [...state.entries] } as T;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

async function run(host: ReturnType<typeof fakeHost>, params: Record<string, unknown>) {
  const tool = createMemoryTool(host as never);
  const result = (await tool.execute(
    "call-1",
    params as never,
    undefined as never,
  )) as { content: { text: string }[]; isError?: boolean; details?: Record<string, unknown> };
  return { text: result.content.map((part) => part.text).join("\n"), isError: result.isError };
}

describe("createMemoryTool", () => {
  it("adds an entry and persists it", async () => {
    const host = fakeHost(["existing"]);
    const { text, isError } = await run(host, {
      target: "memory",
      action: "add",
      content: "a new note",
    });
    expect(isError).toBeFalsy();
    expect(text).toContain("Entry added.");
    expect(host.state.entries).toEqual(["existing", "a new note"]);
  });

  it("patches one span and keeps the rest of the entry", async () => {
    const host = fakeHost(["likes tea and biscuits"]);
    await run(host, { target: "user", action: "patch", old_text: "tea", content: "coffee" });
    expect(host.state.entries).toEqual(["likes coffee and biscuits"]);
  });

  it("applies a batch atomically", async () => {
    const host = fakeHost(["stale note", "keep"]);
    await run(host, {
      target: "memory",
      operations: [
        { action: "remove", old_text: "stale note" },
        { action: "add", content: "fresh note" },
      ],
    });
    expect(host.state.entries).toEqual(["keep", "fresh note"]);
  });

  it("reports a refused edit as text so the model can retry, not as a tool error", async () => {
    const host = fakeHost(["the user prefers coffee"]);
    const { text, isError } = await run(host, {
      target: "memory",
      action: "replace",
      old_text: "the user prefers tea",
      content: "x",
    });
    expect(isError).toBeFalsy();
    expect(text).toContain("No entry matched");
    expect(text).toContain("closest_entries:");
    // Nothing was written.
    expect(host.state.entries).toEqual(["the user prefers coffee"]);
  });

  it("rejects a missing target before touching the store", async () => {
    const host = fakeHost(["a"]);
    const { isError, text } = await run(host, { action: "add", content: "x" });
    expect(isError).toBe(true);
    expect(text).toContain("target is required");
    expect(host.state.entries).toEqual(["a"]);
  });

  it("surfaces a write failure as a tool error", async () => {
    const host = fakeHost([]);
    const failing = {
      state: host.state,
      call: async (method: string) => {
        if (method === "memory.entries") return { entries: [] };
        throw new Error("host offline");
      },
    };
    const { isError, text } = await run(failing as never, {
      target: "memory",
      action: "add",
      content: "x",
    });
    expect(isError).toBe(true);
    expect(text).toContain("was not saved");
  });
});
