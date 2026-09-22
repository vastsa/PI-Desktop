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

describe("hosted search output budget", () => {
  const context = (text: string): OutputCapContext => ({
    messages: [{
      role: "assistant",
      content: [{
        type: "hostedSearch",
        phase: "web_search_tool_result",
        blockId: "search_fixture",
        wire: {
          type: "web_search_tool_result",
          tool_use_id: "search_fixture",
          content: [{ type: "web_search_result", title: text }],
        },
      }],
    }],
  });

  it("scales with hosted search replay rather than charging a fixed image budget", () => {
    const small = estimateOutputCapInputTokens(context("a".repeat(100)));
    const large = estimateOutputCapInputTokens(context("a".repeat(10_100)));
    expect(small).toBeGreaterThan(0);
    expect(large - small).toBe(2500);
  });

  it("applies CJK correction to hosted search replay", () => {
    const ascii = estimateOutputCapInputTokens(context("a".repeat(1000)));
    const cjk = estimateOutputCapInputTokens(context("中".repeat(1000)));
    expect(cjk - ascii).toBe(750);
  });
});

describe("hosted search target model threading", () => {
  /** A Responses target model, identity included as the adapters stamp it. */
  const RESPONSES_MODEL = {
    contextWindow: 262_144,
    maxTokens: 32_768,
    api: "openai-responses",
    provider: "openai",
    id: "gpt-test",
  };

  const searchCall = (size: number) => ({
    type: "hostedSearch",
    phase: "web_search_call",
    blockId: "search_fixture",
    wire: {
      type: "web_search_call",
      id: "search_fixture",
      status: "completed",
      action: { type: "search", query: "a".repeat(size) },
    },
  });

  const responsesContext = (
    model: string,
    size: number,
  ): OutputCapContext => ({
    messages: [
      {
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model,
        content: [searchCall(size)],
      },
    ],
  });

  it("charges same-model Responses search and grows with the payload", () => {
    const small = estimateOutputCapInputTokens(
      responsesContext("gpt-test", 100),
      RESPONSES_MODEL,
    );
    const large = estimateOutputCapInputTokens(
      responsesContext("gpt-test", 10_100),
      RESPONSES_MODEL,
    );
    expect(small).toBeGreaterThan(0);
    expect(large - small).toBe(2_500);
  });

  it("charges nothing for Responses search the target model discards", () => {
    // The Responses adapter replays a `web_search_call` only when the
    // assistant message came from the target model; the wire request carries
    // nothing for any other id, so the estimate must not either.
    expect(
      estimateOutputCapInputTokens(
        responsesContext("other-model", 10_000),
        RESPONSES_MODEL,
      ),
    ).toBe(0);
  });

  it("keeps the conservative estimate when no target identity is known", () => {
    // A caller holding window facts only (no `api`) cannot know which search
    // items the provider replays; charging them keeps the clamp safe.
    expect(
      estimateOutputCapInputTokens(
        responsesContext("other-model", 400),
        LARGE_WINDOW_MODEL,
      ),
    ).toBeGreaterThan(0);
  });

  it("keeps Anthropic search replay across models", () => {
    const target = {
      contextWindow: 200_000,
      maxTokens: 8_192,
      api: "anthropic-messages",
      provider: "anthropic",
      id: "claude-test",
    };
    const estimate = estimateOutputCapInputTokens(
      {
        messages: [
          {
            role: "assistant",
            api: "anthropic-messages",
            provider: "anthropic",
            model: "claude-other",
            content: [
              {
                type: "hostedSearch",
                phase: "web_search_tool_result",
                blockId: "search_fixture",
                wire: {
                  type: "web_search_tool_result",
                  tool_use_id: "search_fixture",
                  content: [
                    { type: "web_search_result", title: "a".repeat(400) },
                  ],
                },
              },
            ],
          },
        ],
      },
      target,
    );
    // The encrypted Anthropic results replay regardless of the message's model
    // id, so they stay in the estimate.
    expect(estimate).toBeGreaterThan(0);
  });

  it("leaves text, thinking and tool blocks unaffected by the target", () => {
    const context: OutputCapContext = {
      messages: [
        {
          role: "assistant",
          api: "openai-responses",
          provider: "openai",
          model: "gpt-test",
          content: [
            { type: "text", text: "a".repeat(400) },
            { type: "thinking", thinking: "中".repeat(100) },
            { type: "toolCall", name: "run", arguments: { a: 1 } },
          ],
        },
      ],
    };
    // 400 text chars (/4 = 100) + 100 CJK thinking chars (baseline 25, CJK
    // correction 75) + the serialized tool call (10 chars).
    expect(estimateOutputCapInputTokens(context, RESPONSES_MODEL)).toBe(203);
    expect(estimateOutputCapInputTokens(context)).toBe(203);
  });

  it("stops charging cross-model search against the output budget", () => {
    const requested = 32_768;
    // 2M chars of same-model search dwarfs the window and collapses the
    // budget; the same payload from another model never reaches the wire.
    expect(
      clampOutputToContext(
        RESPONSES_MODEL,
        responsesContext("gpt-test", 2_000_000),
        requested,
      ),
    ).toBe(1);
    expect(
      clampOutputToContext(
        RESPONSES_MODEL,
        responsesContext("other-model", 2_000_000),
        requested,
      ),
    ).toBe(requested);
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

  it("uses the published window as a safety ceiling", () => {
    const model = {
      contextWindow: 262_144,
      catalogContextWindow: 128_000,
      maxTokens: 200_000,
    };
    expect(clampOutputToContext(model, BASE_CONTEXT, 200_000)).toBe(123_904);
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
