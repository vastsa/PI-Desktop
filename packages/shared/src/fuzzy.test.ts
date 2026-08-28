import { describe, expect, it } from "vitest";
import {
  compareMatches,
  fuzzyMatchCommand,
  fuzzyMatchPath,
  selectBestMatches,
} from "./fuzzy.js";

describe("fuzzyMatchPath", () => {
  it("matches everything on an empty query", () => {
    expect(fuzzyMatchPath("", "src/a.ts")).toEqual({ score: 0, ranges: [] });
    expect(fuzzyMatchPath("", "src", "dir")).toEqual({ score: 10, ranges: [] });
  });

  it("ranks exact file name above prefix above substring above path", () => {
    const exact = fuzzyMatchPath("app.ts", "src/app.ts")!;
    const prefix = fuzzyMatchPath("app", "src/app.test.ts")!;
    const substr = fuzzyMatchPath("pp", "src/app.ts")!;
    const inPath = fuzzyMatchPath("src", "src/other.ts")!;
    expect(exact.score).toBeGreaterThan(prefix.score);
    expect(prefix.score).toBeGreaterThan(substr.score);
    expect(substr.score).toBeGreaterThan(inPath.score);
  });

  it("is case-insensitive and highlights the file-name hit", () => {
    const match = fuzzyMatchPath("APP", "src/App.tsx")!;
    expect(match.ranges).toEqual([[4, 7]]);
  });

  it("matches across separators when the query has a slash", () => {
    const match = fuzzyMatchPath("src/ap", "src/app.ts")!;
    expect(match.score).toBeGreaterThan(0);
    expect(match.ranges).toEqual([[0, 6]]);
  });

  it("falls back to a subsequence with merged ranges", () => {
    const match = fuzzyMatchPath("sapp", "src/app.ts")!;
    expect(match.score).toBe(10);
    expect(match.ranges).toEqual([
      [0, 1],
      [4, 7],
    ]);
  });

  it("returns null when characters are missing", () => {
    expect(fuzzyMatchPath("zzz", "src/app.ts")).toBeNull();
  });

  it("gives directories a bonus at equal quality", () => {
    const dir = fuzzyMatchPath("src", "src", "dir")!;
    const file = fuzzyMatchPath("src", "src")!;
    expect(dir.score).toBe(file.score + 10);
  });
});

describe("fuzzyMatchCommand", () => {
  it("ranks prefix over substring over subsequence", () => {
    const prefix = fuzzyMatchCommand("re", "review")!;
    const substr = fuzzyMatchCommand("vie", "review")!;
    const subseq = fuzzyMatchCommand("rw", "review")!;
    expect(prefix.score).toBeGreaterThan(substr.score);
    expect(substr.score).toBeGreaterThan(subseq.score);
    expect(fuzzyMatchCommand("xyz", "review")).toBeNull();
  });
});

describe("compareMatches", () => {
  it("sorts by score, then length, then lexical", () => {
    const entries = [
      { score: 50, text: "src/bb.ts" },
      { score: 80, text: "src/aa.ts" },
      { score: 50, text: "a.ts" },
      { score: 50, text: "src/ab.ts" },
    ];
    const sorted = [...entries].sort(compareMatches);
    expect(sorted.map((e) => e.text)).toEqual([
      "src/aa.ts",
      "a.ts",
      "src/ab.ts",
      "src/bb.ts",
    ]);
  });
});

describe("selectBestMatches", () => {
  // Score ties are the interesting case: they force the length and lexical
  // tiebreakers, which is where a bounded insertion could diverge from a sort.
  const candidates = Array.from({ length: 240 }, (_, i) => ({
    text: `${"d".repeat(i % 5)}src/mod-${String(i % 60).padStart(2, "0")}.ts`,
    score: [0, 10, 40, 60, 80][i % 5]!,
  }));
  const key = (candidate: { score: number; text: string }) => candidate;
  const sorted = [...candidates].sort(compareMatches);

  it("matches a full sort truncated to the limit", () => {
    for (const limit of [1, 3, 7, 50, 239]) {
      expect(selectBestMatches(candidates, limit, key)).toEqual(
        sorted.slice(0, limit),
      );
    }
  });

  it("keeps the same order when the input order changes", () => {
    const reversed = [...candidates].reverse();
    expect(selectBestMatches(reversed, 12, key).map((c) => c.text)).toEqual(
      [...reversed].sort(compareMatches).slice(0, 12).map((c) => c.text),
    );
  });

  it("returns nothing for a non-positive limit", () => {
    expect(selectBestMatches(candidates, 0, key)).toEqual([]);
    expect(selectBestMatches(candidates, -1, key)).toEqual([]);
  });

  it("returns every candidate in sorted order past the candidate count", () => {
    expect(selectBestMatches(candidates, candidates.length + 10, key)).toEqual(
      sorted,
    );
  });
});
