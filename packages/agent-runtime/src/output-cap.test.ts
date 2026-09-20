import { describe, expect, it } from "vitest";
import {
  clampOutputToContext,
  estimateOutputCapInputTokens,
  type OutputCapContext,
} from "./output-cap.js";

const BASE_CONTEXT: OutputCapContext = {
  messages: [],
};

/** A generic 256k-window model; tests must not depend on any concrete vendor. */
const LARGE_WINDOW_MODEL = { contextWindow: 262_144, maxTokens: 32_768 };

describe("estimateOutputCapInputTokens", () => {
  it("counts ASCII text at the chars/4 baseline", () => {
    const context: OutputCapContext = {
      messages: [{ role: "user", content: "a".repeat(4000) }],
    };
    expect(estimateOutputCapInputTokens(context)).toBe(1000);
  });

  it("counts CJK text at ~1 token per char instead of 0.25", () => {
    const context: OutputCapContext = {
      messages: [{ role: "user", content: "中".repeat(1000) }],
    };
    // chars/4 baseline = 250; CJK correction adds ceil(1000 * 0.75) = 750.
    expect(estimateOutputCapInputTokens(context)).toBe(1000);
  });

  it("counts image blocks via the wire-format estimate", () => {
    const context: OutputCapContext = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", image: { mediaType: "image/png" } },
            { type: "text", text: "abc" },
          ],
        },
      ],
    };
    // 4800 chars for the image + 3 for the text → ceil(4803 / 4).
    expect(estimateOutputCapInputTokens(context)).toBe(1201);
  });

  it("counts the system prompt and tool schemas", () => {
    const context: OutputCapContext = {
      systemPrompt: "a".repeat(4000),
      messages: [],
      tools: [{ name: "x", description: "b".repeat(4000) }],
    };
    // 1000 (system) + ceil(4030 / 4) for the serialized tool array (the JSON
    // wrapper carries 30 extra chars on top of the 4000-char description).
    expect(estimateOutputCapInputTokens(context)).toBe(2008);
  });

  it("treats a raw string content and empty content consistently", () => {
    expect(
      estimateOutputCapInputTokens({
        messages: [{ role: "user", content: "".repeat(0) }],
      }),
    ).toBe(0);
  });
});

describe("clampOutputToContext", () => {
  it("keeps the requested budget when the input leaves enough room", () => {
    expect(
      clampOutputToContext(LARGE_WINDOW_MODEL, BASE_CONTEXT, 32_768),
    ).toBe(32_768);
  });

  it("uses the model default when no budget is requested", () => {
    expect(clampOutputToContext(LARGE_WINDOW_MODEL, BASE_CONTEXT, undefined)).toBe(
      32_768,
    );
  });

  it("returns a concrete clamped number even when the requested budget is huge", () => {
    const context: OutputCapContext = {
      // 500,000 estimated tokens already exceeds the 262,144 window, so the
      // output budget collapses to the 1-token floor.
      messages: [{ role: "user", content: "a".repeat(2_000_000) }],
    };
    const clamped = clampOutputToContext(LARGE_WINDOW_MODEL, context, 100_000);
    expect(clamped).toBe(1);
  });

  it("cuts the output budget for a CJK-heavy session near the window edge", () => {
    // A CJK-heavy session near the edge of the window must have its output
    // budget cut so `estimated input + output + reserve` still fits. The
    // chars/4 baseline alone would under-count the input by ~0.75 token per
    // CJK char and could let a large configured output slip through.
    const context: OutputCapContext = {
      messages: [
        { role: "user", content: "中".repeat(200_000) },
        {
          role: "assistant",
          content: [
            { type: "text", text: "已" },
            {
              type: "toolCall",
              name: "read_file",
              arguments: JSON.stringify({ path: "/tmp/a.md" }),
            },
          ],
        },
      ],
    };
    const estimate = estimateOutputCapInputTokens(context);
    const clamped = clampOutputToContext(LARGE_WINDOW_MODEL, context, 92_709);
    expect(estimate).toBeGreaterThan(160_000);
    // estimate (≥160k) + clamped + reserve (4096) must fit the 262144 window.
    expect(estimate + clamped + 4096).toBeLessThanOrEqual(
      LARGE_WINDOW_MODEL.contextWindow,
    );
    expect(clamped).toBeLessThan(92_709);
  });

  it("keeps the requested budget when the window is unknown", () => {
    const model = { contextWindow: 0, maxTokens: 4096 };
    expect(clampOutputToContext(model, BASE_CONTEXT, 8888)).toBe(8888);
  });

  it("never exceeds the requested budget", () => {
    const context: OutputCapContext = {
      messages: [{ role: "user", content: "a".repeat(100) }],
    };
    for (const requested of [1, 128, 4096, 32_768, 100_000]) {
      expect(
        clampOutputToContext(LARGE_WINDOW_MODEL, context, requested),
      ).toBeLessThanOrEqual(requested);
    }
  });
});
