import { describe, expect, it } from "vitest";
import { getCurrentSystemPrompt, normalizeContext, type Message } from "@earendil-works/pi-ai";
import {
  clampOutputToContext,
  estimateOutputCapInputTokens,
  requestTranscript,
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

  it("counts CJK inside tool-call arguments at ~1 token per char", () => {
    // JSON.stringify leaves Han unescaped. "Write" (5) plus
    // {"content":"<1000 中>"} (1014) is 1019 chars: baseline 255, and the
    // correction adds ceil(1000 * 0.75) = 750.
    const context: OutputCapContext = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "Write",
              arguments: { content: "中".repeat(1000) },
            },
          ],
        },
      ],
    };
    expect(estimateOutputCapInputTokens(context)).toBe(1005);
  });

  it("leaves ASCII tool-call arguments on the chars/4 baseline", () => {
    const context: OutputCapContext = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "Write",
              arguments: { content: "a".repeat(1000) },
            },
          ],
        },
      ],
    };
    // Same name and JSON wrapper as the CJK case, so the correction adds 0.
    expect(estimateOutputCapInputTokens(context)).toBe(255);
  });

  it("counts Japanese kana at ~1 token per char, same as Han", () => {
    const han = estimateOutputCapInputTokens({
      messages: [{ role: "user", content: "中".repeat(1000) }],
    });
    // 9-char hiragana/katakana phrase, sliced to the same 1000 chars as Han.
    const kana = "こんにちはカタカナ".repeat(112).slice(0, 1000);
    expect(kana).toHaveLength(1000);
    // chars/4 baseline = 250; the 0.75/char correction brings this to 1000.
    expect(
      estimateOutputCapInputTokens({ messages: [{ role: "user", content: kana }] }),
    ).toBe(han);
  });

  it("counts Korean Hangul at ~1 token per char, same as Han", () => {
    const han = estimateOutputCapInputTokens({
      messages: [{ role: "user", content: "中".repeat(1000) }],
    });
    const hangul = "안녕하세요".repeat(200);
    expect(hangul).toHaveLength(1000);
    expect(
      estimateOutputCapInputTokens({
        messages: [{ role: "user", content: hangul }],
      }),
    ).toBe(han);
  });

  it("counts Hangul jamo, katakana extensions, and compatibility ideographs like Han", () => {
    const estimate = (content: string) =>
      estimateOutputCapInputTokens({ messages: [{ role: "user", content }] });
    const han = estimate("中".repeat(1000));
    expect({
      jamo: estimate("\u1100".repeat(1000)),
      compatJamo: estimate("\u3131".repeat(1000)),
      kanaExtension: estimate("\u31F0".repeat(1000)),
      compatIdeograph: estimate("\uF900".repeat(1000)),
    }).toEqual({
      jamo: han,
      compatJamo: han,
      kanaExtension: han,
      compatIdeograph: han,
    });
  });

  it("does not count ASCII, Latin, or Cyrillic as CJK", () => {
    const ascii = "a".repeat(1000);
    const latin = "café".repeat(250);
    const cyrillic = "я".repeat(1000);
    expect(latin).toHaveLength(1000);
    expect(cyrillic).toHaveLength(1000);
    // chars/4 only. Counting é or я would add ceil(n * 0.75) on top of 250.
    expect(
      estimateOutputCapInputTokens({ messages: [{ role: "user", content: ascii }] }),
    ).toBe(250);
    expect(
      estimateOutputCapInputTokens({ messages: [{ role: "user", content: latin }] }),
    ).toBe(250);
    expect(
      estimateOutputCapInputTokens({
        messages: [{ role: "user", content: cyrillic }],
      }),
    ).toBe(250);
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

  it("charges Codex Responses search replay only to its source model", () => {
    const codexModel = {
      ...RESPONSES_MODEL,
      api: "openai-codex-responses",
      provider: "openai-codex",
      id: "gpt-codex-test",
    };
    const codexContext = (model: string, size: number): OutputCapContext => ({
      messages: [{
        role: "assistant",
        api: "openai-codex-responses",
        provider: "openai-codex",
        model,
        content: [searchCall(size)],
      }],
    });
    const same = estimateOutputCapInputTokens(codexContext("gpt-codex-test", 100), codexModel);
    const other = estimateOutputCapInputTokens(codexContext("other-model", 100), codexModel);
    expect(same).toBeGreaterThan(0);
    expect(other).toBe(0);
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

  it("cuts the output budget when CJK tool arguments fill a 128k window", () => {
    // 110k Han characters in a Write payload. chars/4 alone is 27505 and
    // would leave a requested 32768 max_tokens untouched on a 128k window.
    const model = { contextWindow: 128_000, maxTokens: 32_768 };
    const context: OutputCapContext = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              name: "Write",
              arguments: { content: "中".repeat(110_000) },
            },
          ],
        },
      ],
    };
    const estimate = estimateOutputCapInputTokens(context);
    const clamped = clampOutputToContext(model, context, 32_768);
    expect(estimate).toBe(110_005);
    expect(clamped).toBeLessThan(32_768);
    expect(estimate + clamped + 4096).toBeLessThanOrEqual(128_000);
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

  it("cuts the output budget for a Hangul-heavy session near the window edge", () => {
    // Same shape as the Han case. A syllable is ~1 token; chars/4 alone would
    // leave the requested output in place and let input + output pass the window.
    const context: OutputCapContext = {
      messages: [
        { role: "user", content: "안녕하세요".repeat(40_000) },
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
    // estimate (≥160k) + clamped + reserve (4096) must fit the 262144 window,
    // with the budget cut to the context remainder.
    expect(estimate + clamped + 4096).toBeLessThanOrEqual(
      LARGE_WINDOW_MODEL.contextWindow,
    );
    expect(clamped).toBe(LARGE_WINDOW_MODEL.contextWindow - estimate - 4096);
    expect(clamped).toBeLessThan(92_709);
    // 200k syllables at ~1 token each, independent of the estimator. Returning
    // the requested 92_709 would make this sum exceed the window.
    expect(200_000 + clamped).toBeLessThanOrEqual(
      LARGE_WINDOW_MODEL.contextWindow,
    );
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

describe("requestTranscript", () => {
  const updates = (count: number): Message[] => [
    { role: "system", content: "Base instructions.", timestamp: 1 },
    ...Array.from({ length: count }, (_, index): Message => ({
      role: "system", content: "", sections: { context: `${index}`.padEnd(40_000, "x") }, timestamp: 2 + index,
    })),
    { role: "user", content: "Continue.", timestamp: 100 },
  ];
  const model = { contextWindow: 128_000, maxTokens: 8_192, compat: { supportsMidConvoSystemMessages: false } };

  it("charges only the current instructions when the adapter folds system updates", () => {
    const context = normalizeContext({ messages: updates(16) });
    const request = requestTranscript(model, context);
    expect(request.messages.filter((message) => message.role === "system")).toHaveLength(1);
    expect(getCurrentSystemPrompt(request.messages)).toBe(getCurrentSystemPrompt(context.messages));
    expect(clampOutputToContext(model, context, 8_192)).toBe(1);
    expect(clampOutputToContext(model, request, 8_192)).toBe(8_192);
  });

  it("keeps every update for a model that receives them mid-conversation", () => {
    const midConversation = { ...model, compat: { supportsMidConvoSystemMessages: true } };
    const context = normalizeContext({ messages: updates(16) });
    expect(requestTranscript(midConversation, context)).toBe(context);
    expect(clampOutputToContext(midConversation, requestTranscript(midConversation, context), 8_192)).toBe(1);
  });
});

// Transcript-only Pi requests have no legacy systemPrompt/tools fields.
it("counts instruction sections and tool declarations in transcript-only requests", () => {
  const base = { messages: [{ role: "system", content: "" }] };
  const state = { messages: [{ role: "system", content: "", sections: { skills: "中文说明" }, toolsAdded: [{ name: "Read", parameters: { type: "object" } }] }] };
  expect(estimateOutputCapInputTokens(state)).toBeGreaterThan(estimateOutputCapInputTokens(base));
  expect(estimateOutputCapInputTokens(state)).toBeGreaterThan(4);
});
