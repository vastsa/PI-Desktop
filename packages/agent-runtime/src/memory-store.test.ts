import { describe, expect, it } from "vitest";
import {
  applyMemoryBatch,
  applyMemoryOperation,
  ENTRY_DELIMITER,
  findUniqueMemoryMatch,
  formatMemoryForSystemPrompt,
  MEMORY_BLOCK_HEADERS,
  MEMORY_CHAR_LIMIT,
  memoryCharCount,
  normalizeForMemoryMatch,
  parseMemoryEntries,
  serializeMemoryEntries,
  USER_CHAR_LIMIT,
  type MemoryOperation,
} from "./memory-store.js";

const MEMORY = "memory" as const;

describe("entry list round-trip", () => {
  it("parses a stored document and drops blank entries", () => {
    expect(parseMemoryEntries("one\n§\ntwo")).toEqual(["one", "two"]);
    expect(parseMemoryEntries(`one${ENTRY_DELIMITER}${ENTRY_DELIMITER}two`)).toEqual([
      "one",
      "two",
    ]);
    expect(parseMemoryEntries("   ")).toEqual([]);
    expect(parseMemoryEntries("")).toEqual([]);
  });

  it("serializes back to the same document", () => {
    const entries = ["one", "two"];
    expect(serializeMemoryEntries(entries)).toBe("one\n§\ntwo");
    expect(parseMemoryEntries(serializeMemoryEntries(entries))).toEqual(entries);
  });

  it("measures characters the way the limit is measured", () => {
    expect(memoryCharCount(["a", "b"])).toBe(ENTRY_DELIMITER.length + 2);
    expect(memoryCharCount([])).toBe(0);
  });
});

describe("tolerant matching", () => {
  it("folds curly quotes, dashes and whitespace runs", () => {
    expect(normalizeForMemoryMatch("\u201cquoted\u201d")).toBe("'quoted'");
    expect(normalizeForMemoryMatch("a\u2014b")).toBe("a-b");
    expect(normalizeForMemoryMatch("a   b\nc")).toBe("a b c");
    // A newline the model over-escaped to a literal backslash-n.
    expect(normalizeForMemoryMatch("a\\nb")).toBe("a b");
  });

  it("prefers a whole-entry exact match over a substring match", () => {
    // 'test' is both its own entry and contained in a sibling.
    const entries = ["test", "all tests pass"];
    expect(findUniqueMemoryMatch(entries, "test")).toEqual({ index: 0, ambiguous: false });
  });

  it("reports ambiguity for two distinct matches", () => {
    const entries = ["alpha one", "alpha two"];
    expect(findUniqueMemoryMatch(entries, "alpha")).toEqual({ index: null, ambiguous: true });
  });

  it("matches through folded typography", () => {
    const entries = ["user prefers \u201ccoffee\u201d over tea"];
    expect(findUniqueMemoryMatch(entries, "user prefers 'coffee' over tea").index).toBe(0);
  });

  it("does not let punctuation alone select an entry", () => {
    expect(findUniqueMemoryMatch(["alpha", "beta"], "--")).toEqual({
      index: null,
      ambiguous: false,
    });
  });
});

describe("add", () => {
  it("appends a new entry", () => {
    const result = applyMemoryOperation(MEMORY, ["a"], { action: "add", content: "b" });
    expect(result.success).toBe(true);
    expect(result.success && result.entries).toEqual(["a", "b"]);
  });

  it("is idempotent so a retried call does not duplicate", () => {
    const result = applyMemoryOperation(MEMORY, ["a"], { action: "add", content: "a" });
    expect(result.success).toBe(true);
    expect(result.success && result.entries).toEqual(["a"]);
    expect(result.success && result.message).toContain("already exists");
  });

  it("rejects empty content", () => {
    const result = applyMemoryOperation(MEMORY, [], { action: "add", content: "   " });
    expect(result.success).toBe(false);
    expect(!result.success && result.failureClass).toBe("missing_content");
  });

  it("refuses an add that would exceed the budget, and lists what is there", () => {
    const full = "x".repeat(MEMORY_CHAR_LIMIT);
    const result = applyMemoryOperation(MEMORY, [full], { action: "add", content: "more" });
    expect(result.success).toBe(false);
    expect(!result.success && result.failureClass).toBe("over_budget");
    expect(!result.success && result.currentEntries).toEqual([full]);
  });
});

describe("replace", () => {
  it("replaces the WHOLE entry, using old_text only to locate it", () => {
    const result = applyMemoryOperation(MEMORY, ["deploy target is staging"], {
      action: "replace",
      old_text: "staging",
      content: "deploy target is production",
    });
    expect(result.success && result.entries).toEqual(["deploy target is production"]);
    expect(result.success && result.previousEntry).toBe("deploy target is staging");
  });

  it("reports the closest entries when nothing matches", () => {
    const result = applyMemoryOperation(MEMORY, ["the user prefers coffee"], {
      action: "replace",
      old_text: "the user prefers tea",
      content: "unused",
    });
    expect(result.success).toBe(false);
    expect(!result.success && result.failureClass).toBe("no_match");
    expect(!result.success && result.closestEntries).toEqual(["the user prefers coffee"]);
  });

  it("asks for a more specific old_text when two entries match", () => {
    const result = applyMemoryOperation(MEMORY, ["alpha one", "alpha two"], {
      action: "replace",
      old_text: "alpha",
      content: "x",
    });
    expect(result.success).toBe(false);
    expect(!result.success && result.failureClass).toBe("ambiguous");
  });

  it("requires content", () => {
    const result = applyMemoryOperation(MEMORY, ["a"], {
      action: "replace",
      old_text: "a",
      content: " ",
    });
    expect(!result.success && result.failureClass).toBe("missing_content");
  });
});

describe("patch", () => {
  it("edits one span and keeps the rest of the entry verbatim", () => {
    const result = applyMemoryOperation(MEMORY, ["likes tea and biscuits"], {
      action: "patch",
      old_text: "tea",
      content: "coffee",
    });
    expect(result.success && result.entries).toEqual(["likes coffee and biscuits"]);
    expect(result.success && result.patchedEntry).toBe("likes coffee and biscuits");
  });

  it("refuses a span that occurs more than once", () => {
    const result = applyMemoryOperation(MEMORY, ["tea and more tea"], {
      action: "patch",
      old_text: "tea",
      content: "coffee",
    });
    expect(result.success).toBe(false);
    expect(!result.success && result.failureClass).toBe("ambiguous");
    expect(!result.success && result.error).toContain("2 times");
  });

  it("rejects an empty new text and points at remove", () => {
    const result = applyMemoryOperation(MEMORY, ["a b"], {
      action: "patch",
      old_text: "a",
      content: "  ",
    });
    expect(!result.success && result.failureClass).toBe("missing_content");
    expect(!result.success && result.error).toContain("remove");
  });
});

describe("remove", () => {
  it("deletes the matched entry only", () => {
    const result = applyMemoryOperation(MEMORY, ["keep me", "drop me"], {
      action: "remove",
      old_text: "drop me",
    });
    expect(result.success && result.entries).toEqual(["keep me"]);
    expect(result.success && result.previousEntry).toBe("drop me");
  });

  it("requires old_text", () => {
    const result = applyMemoryOperation(MEMORY, ["a"], { action: "remove", old_text: "" });
    expect(!result.success && result.failureClass).toBe("missing_old_text");
  });
});

describe("batch", () => {
  it("is all-or-nothing: one bad op writes nothing", () => {
    const operations: MemoryOperation[] = [
      { action: "add", content: "new" },
      { action: "remove", old_text: "missing entry" },
    ];
    const result = applyMemoryBatch(MEMORY, ["old"], operations);
    expect(result.success).toBe(false);
    expect(!result.success && result.failureClass).toBe("no_match");
    expect(!result.success && result.error).toContain("operation 2");
  });

  it("frees space and spends it in one batch", () => {
    // Two entries fill the budget; the batch removes one and adds another, so the
    // intermediate state is over the limit but the final state is not.
    const half = Math.floor((MEMORY_CHAR_LIMIT - ENTRY_DELIMITER.length) / 2);
    const first = "a".repeat(half);
    const second = "b".repeat(half);
    const replacement = "c".repeat(half);
    const entries = [first, second];
    expect(memoryCharCount(entries)).toBeLessThanOrEqual(MEMORY_CHAR_LIMIT);

    const result = applyMemoryBatch(MEMORY, entries, [
      { action: "remove", old_text: second },
      { action: "add", content: replacement },
    ]);
    expect(result.success).toBe(true);
    expect(result.success && result.entries).toEqual([first, replacement]);
  });

  it("rejects an empty operation list", () => {
    const result = applyMemoryBatch(MEMORY, ["a"], []);
    expect(!result.success && result.failureClass).toBe("invalid_args");
  });

  it("measures the budget on the final result only", () => {
    const huge = "z".repeat(MEMORY_CHAR_LIMIT);
    const result = applyMemoryBatch(MEMORY, [huge], [
      { action: "remove", old_text: huge },
      { action: "add", content: "small" },
    ]);
    expect(result.success && result.entries).toEqual(["small"]);
  });
});

describe("system prompt rendering", () => {
  it("renders a header and one bullet per entry", () => {
    const block = formatMemoryForSystemPrompt(MEMORY, ["likes tea", "ships on fridays"]);
    expect(block).toContain(MEMORY_BLOCK_HEADERS.memory);
    expect(block?.split("\n").filter((line) => line.startsWith("- "))).toEqual([
      "- likes tea",
      "- ships on fridays",
    ]);
  });

  it("renders nothing for an empty store", () => {
    expect(formatMemoryForSystemPrompt("user", [])).toBeUndefined();
    expect(formatMemoryForSystemPrompt("user", ["  "])).toBeUndefined();
  });

  it("uses the user-profile header and its own budget", () => {
    expect(formatMemoryForSystemPrompt("user", ["prefers Chinese"])).toContain(
      MEMORY_BLOCK_HEADERS.user,
    );
    expect(USER_CHAR_LIMIT).toBeLessThan(MEMORY_CHAR_LIMIT);
  });
});
