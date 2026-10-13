import { describe, expect, it } from "vitest";
import type { UiMessage } from "@pi-desktop/shared";
import { delegationTrace } from "./delegation-trace.js";

describe("bounded delegation excerpts", () => {
  const rows: UiMessage[] = Array.from({ length: 20 }, (_, index) => ({
    id: `row-${index}`, role: "assistant", content: "x".repeat(20_000) + "needle", createdAt: "2026-10-01T00:00:00Z",
  }));
  it("caps page text independently of limit and locates a literal match past the default excerpt", () => {
    const page = delegationTrace(rows, { query: "NEEDLE", limit: 20 });
    expect(page.entries.every((entry) => entry.text.includes("needle") && entry.truncated)).toBe(true);
    expect(page.entries.reduce((size, entry) => size + entry.text.length, 0)).toBeLessThanOrEqual(10_000);
    const first = delegationTrace(rows, { limit: 20 });
    expect(first.entries).toHaveLength(5);
    expect(first.nextAfter).toBe("row-4");
    const next = delegationTrace(rows, { after: first.nextAfter, limit: 20 });
    expect(next.entries[0].messageId).toBe("row-5");
  });
  it("handles empty and thinking-only traces, literal queries, and cursor errors", () => {
    expect(delegationTrace([{ ...rows[0], content: "", thinking: "needle" }], { query: "needle" })).toEqual({ entries: [] });
    expect(delegationTrace(rows, { query: "[.*]" })).toEqual({ entries: [] });
    expect(() => delegationTrace(rows, { after: "missing" })).toThrow("cursor");
    expect(() => delegationTrace(rows, { query: " " })).toThrow("query");
  });
});
