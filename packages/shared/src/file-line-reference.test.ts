import { describe, expect, it } from "vitest";
import { parseFileLineRange, parseFileLineReference } from "./file-line-reference.js";

describe("file line selection bounds", () => {
  it("accepts a bounded selection at the largest supported line number", () => {
    expect(parseFileLineRange({ start: 2_147_483_646, end: 2_147_483_647 }))
      .toEqual({ start: 2_147_483_646, end: 2_147_483_647 });
    expect(parseFileLineRange({ start: 85, end: 4084 })).toEqual({ start: 85, end: 4084 });
  });

  it.each([
    { start: 1, end: 9e15 },
    { start: 2_147_483_648, end: 2_147_483_648 },
    { start: 85, end: 4085 },
    { start: 0, end: 1 },
    { start: 2, end: 1 },
    { start: 1, end: 1.5 },
  ])("rejects an unsupported selection $start:$end without relabelling it", (range) => {
    expect(parseFileLineRange(range)).toBeUndefined();
    expect(parseFileLineReference({ ...range, path: "/project/a.ts", workspace: "/project" })).toBeUndefined();
  });
});
