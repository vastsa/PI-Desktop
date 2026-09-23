import { describe, expect, it } from "vitest";

import {
  hostedSearchFromBlocks,
  hostedSearchFromMessage,
  hostedSearchReplayBlocks,
  hostedSearchRounds,
  nativeWebSearchSupportedOn,
  nativeWebSearchToolFor,
  resolveNativeWebSearch,
} from "./native-web-search.js";

describe("resolveNativeWebSearch", () => {
  it("turns on only for wires that define a hosted search tool", () => {
    expect(resolveNativeWebSearch({ wireApi: "anthropic-messages", modelWebSearch: true })).toBe("on");
    expect(resolveNativeWebSearch({ wireApi: "openai-responses", modelWebSearch: true })).toBe("on");
    expect(resolveNativeWebSearch({ wireApi: "azure-openai-responses", modelWebSearch: true })).toBe("on");
    expect(resolveNativeWebSearch({ wireApi: "openai-codex-responses", modelWebSearch: true })).toBe("on");
  });

  it("stays off for wires without a hosted search tool", () => {
    for (const wire of ["openai-completions", "google-generative-ai", "pi-messages", ""]) {
      expect(resolveNativeWebSearch({ wireApi: wire, modelWebSearch: true })).toBe("off");
    }
  });

  it("requires the explicit binding opt-in; absence is off", () => {
    expect(resolveNativeWebSearch({ wireApi: "openai-responses" })).toBe("off");
    expect(resolveNativeWebSearch({ wireApi: "openai-responses", modelWebSearch: false })).toBe("off");
    expect(resolveNativeWebSearch({ wireApi: "openai-responses", modelWebSearch: undefined })).toBe("off");
  });

  it("normalizes wire spelling before matching", () => {
    expect(resolveNativeWebSearch({ wireApi: " Anthropic-Messages ", modelWebSearch: true })).toBe("on");
  });

  it("never infers support from unrelated inputs", () => {
    expect(resolveNativeWebSearch({ wireApi: "openai-completions", modelWebSearch: true })).toBe("off");
  });
});

describe("nativeWebSearchToolFor", () => {
  it("maps each supported wire to its vendor tool shape", () => {
    expect(nativeWebSearchToolFor("anthropic-messages")).toEqual({ type: "web_search_20250305", name: "web_search" });
    expect(nativeWebSearchToolFor("openai-responses")).toEqual({ type: "web_search" });
    expect(nativeWebSearchToolFor("azure-openai-responses")).toEqual({ type: "web_search" });
    expect(nativeWebSearchToolFor("openai-codex-responses")).toEqual({ type: "web_search" });
  });

  it("returns undefined for wires without a tool shape", () => {
    expect(nativeWebSearchToolFor("openai-completions")).toBeUndefined();
    expect(nativeWebSearchToolFor("")).toBeUndefined();
  });
});

describe("hostedSearchFromBlocks", () => {
  it("normalizes a responses web_search_call block into one round", () => {
    const search = hostedSearchFromBlocks({
      content: [
        {
          type: "hostedSearch",
          phase: "web_search_call",
          blockId: "ws_1",
          status: "completed",
          wire: {
            type: "web_search_call",
            id: "ws_1",
            status: "completed",
            action: { type: "search", query: "pi-desktop release notes" },
            results: [
              { url: "https://example.com/a", title: "A" },
              { url: "https://example.com/b", title: "  " },
            ],
          },
        },
      ],
      citations: [
        { url: "https://example.com/a", title: "A" },
        { url: "https://example.com/c", title: "C" },
        { url: "not-a-url" },
      ],
    });
    expect(search).toEqual({
      status: "completed",
      rounds: [
        {
          id: "ws_1",
          status: "completed",
          query: "pi-desktop release notes",
          sources: [
            { url: "https://example.com/a", title: "A" },
            { url: "https://example.com/b" },
            // Citation-only URLs fold into the most recent round, deduped.
            { url: "https://example.com/c", title: "C" },
          ],
        },
      ],
    });
  });

  it("keeps each search round separate, in provider order", () => {
    const search = hostedSearchFromBlocks({
      content: [
        {
          type: "hostedSearch",
          phase: "web_search_call",
          blockId: "ws_1",
          status: "completed",
          wire: {
            type: "web_search_call",
            id: "ws_1",
            status: "completed",
            action: {
              type: "search",
              query: "first query",
              sources: [{ url: "https://example.com/1" }],
            },
          },
        },
        {
          type: "hostedSearch",
          phase: "web_search_call",
          blockId: "ws_2",
          status: "in_progress",
          wire: {
            type: "web_search_call",
            id: "ws_2",
            status: "in_progress",
            action: { type: "search", query: "second query" },
          },
        },
      ],
    });
    expect(search).toEqual({
      status: "searching",
      rounds: [
        {
          id: "ws_1",
          status: "completed",
          query: "first query",
          sources: [{ url: "https://example.com/1" }],
        },
        { id: "ws_2", status: "searching", query: "second query", sources: [] },
      ],
    });
  });

  it("pairs an anthropic server_tool_use with its result into one round", () => {
    const search = hostedSearchFromBlocks({
      content: [
        {
          type: "hostedSearch",
          phase: "server_tool_use",
          blockId: "srvu_1",
          name: "web_search",
          input: { query: "rust async" },
        },
        {
          type: "hostedSearch",
          phase: "web_search_tool_result",
          blockId: "srvu_1",
          wire: {
            type: "web_search_tool_result",
            tool_use_id: "srvu_1",
            content: [
              {
                type: "web_search_result",
                url: "https://example.com/rust",
                title: "Rust async",
              },
            ],
          },
        },
      ],
    });
    expect(search).toEqual({
      status: "completed",
      rounds: [
        {
          id: "srvu_1",
          status: "completed",
          query: "rust async",
          sources: [{ url: "https://example.com/rust", title: "Rust async" }],
        },
      ],
    });
  });

  it("marks an anthropic error result as a failed round", () => {
    const search = hostedSearchFromBlocks({
      content: [
        {
          type: "hostedSearch",
          phase: "server_tool_use",
          blockId: "srvu_1",
          input: { query: "rust async" },
        },
        {
          type: "hostedSearch",
          phase: "web_search_tool_result",
          blockId: "srvu_1",
          isError: true,
          wire: {
            type: "web_search_tool_result_error",
            tool_use_id: "srvu_1",
            content: "search unavailable",
          },
        },
      ],
    });
    expect(search).toEqual({
      status: "failed",
      rounds: [
        { id: "srvu_1", status: "failed", query: "rust async", sources: [] },
      ],
    });
  });

  it("pairs an id-less result with the latest round still searching", () => {
    const search = hostedSearchFromBlocks({
      content: [
        {
          type: "hostedSearch",
          phase: "server_tool_use",
          blockId: "srvu_1",
          input: { query: "done round" },
        },
        {
          type: "hostedSearch",
          phase: "web_search_tool_result",
          blockId: "srvu_1",
          wire: { type: "web_search_tool_result", content: [] },
        },
        {
          type: "hostedSearch",
          phase: "server_tool_use",
          blockId: "srvu_2",
          input: { query: "open round" },
        },
        // A gateway that drops the tool_use_id still lands the result on the
        // round that is actually open instead of inventing a new one.
        {
          type: "hostedSearch",
          phase: "web_search_tool_result",
          wire: {
            type: "web_search_tool_result",
            content: [{ url: "https://example.com/open" }],
          },
        },
      ],
    });
    expect(search?.rounds).toEqual([
      { id: "srvu_1", status: "completed", query: "done round", sources: [] },
      {
        id: "srvu_2",
        status: "completed",
        query: "open round",
        sources: [{ url: "https://example.com/open" }],
      },
    ]);
  });

  it("labels responses open_page and find_in_page rounds with their target", () => {
    const search = hostedSearchFromBlocks({
      content: [
        {
          type: "hostedSearch",
          phase: "web_search_call",
          blockId: "ws_1",
          status: "completed",
          wire: {
            type: "web_search_call",
            id: "ws_1",
            status: "completed",
            action: { type: "search", query: "openclaw latest" },
          },
        },
        {
          type: "hostedSearch",
          phase: "web_search_call",
          blockId: "ws_2",
          status: "completed",
          wire: {
            type: "web_search_call",
            id: "ws_2",
            status: "completed",
            action: { type: "open_page", url: "https://www.npmjs.com/package/openclaw" },
          },
        },
        {
          type: "hostedSearch",
          phase: "web_search_call",
          blockId: "ws_3",
          status: "completed",
          wire: {
            type: "web_search_call",
            id: "ws_3",
            status: "completed",
            action: {
              type: "find_in_page",
              url: "https://docs.openclaw.ai/releases",
              pattern: "2026.9",
            },
          },
        },
      ],
    });
    expect(search?.rounds).toEqual([
      { id: "ws_1", status: "completed", query: "openclaw latest", sources: [] },
      {
        id: "ws_2",
        status: "completed",
        kind: "openPage",
        url: "https://www.npmjs.com/package/openclaw",
        sources: [],
      },
      {
        id: "ws_3",
        status: "completed",
        kind: "findInPage",
        url: "https://docs.openclaw.ai/releases",
        query: "2026.9",
        sources: [],
      },
    ]);
  });

  it("labels an anthropic web_fetch use as an open-page round", () => {
    const search = hostedSearchFromBlocks({
      content: [
        {
          type: "hostedSearch",
          phase: "server_tool_use",
          blockId: "srvu_9",
          name: "web_fetch",
          input: { url: "https://example.com/page" },
        },
        {
          type: "hostedSearch",
          phase: "web_search_tool_result",
          blockId: "srvu_9",
          wire: { type: "web_search_tool_result", content: [] },
        },
      ],
    });
    expect(search?.rounds).toEqual([
      {
        id: "srvu_9",
        status: "completed",
        kind: "openPage",
        url: "https://example.com/page",
        sources: [],
      },
    ]);
  });

  it("reads the query from gateway-native search field names", () => {
    // GLM's web_search_prime (relayed by gateways onto the anthropic wire)
    // names its input field `search_query`, not `query`.
    const search = hostedSearchFromBlocks({
      content: [
        {
          type: "hostedSearch",
          phase: "server_tool_use",
          blockId: "srvu_glm",
          name: "web_search_prime",
          input: { location: "us", search_query: "OpenClaw latest version release" },
        },
      ],
    });
    expect(search?.rounds).toEqual([
      {
        id: "srvu_glm",
        status: "searching",
        query: "OpenClaw latest version release",
        sources: [],
      },
    ]);
  });

  it("returns undefined without hostedSearch blocks and never throws on junk", () => {
    expect(hostedSearchFromBlocks({ content: [] })).toBeUndefined();
    expect(
      hostedSearchFromBlocks({ content: [{ type: "text", text: "hi" }] }),
    ).toBeUndefined();
    // A block without a recognized phase carries no round information.
    expect(
      hostedSearchFromBlocks({
        content: [null, 7, { type: "hostedSearch" }] as unknown[],
      }),
    ).toBeUndefined();
    expect(
      hostedSearchFromBlocks({
        content: [{ type: "hostedSearch", phase: "web_search_call", wire: "junk" }],
        citations: [{ url: "ftp://nope" }],
      }),
    ).toEqual({
      status: "searching",
      rounds: [{ id: "anon-0", status: "searching", sources: [] }],
    });
  });
});

describe("hostedSearchRounds", () => {
  it("passes through the per-round shape", () => {
    const rounds = [
      { id: "ws_1", status: "completed" as const, query: "q", sources: [] },
    ];
    expect(hostedSearchRounds({ status: "completed", rounds })).toEqual(rounds);
  });

  it("collapses a v1 aggregate transcript into one legacy round", () => {
    const legacy = {
      status: "completed",
      queries: ["old query"],
      sources: [{ url: "https://example.com/a", title: "A" }],
    };
    expect(
      hostedSearchRounds(legacy as unknown as Parameters<typeof hostedSearchRounds>[0]),
    ).toEqual([
      {
        id: "legacy",
        status: "completed",
        query: "old query",
        sources: [{ url: "https://example.com/a", title: "A" }],
      },
    ]);
  });

  it("reads nothing from empty or missing data", () => {
    expect(hostedSearchRounds(undefined)).toEqual([]);
    expect(
      hostedSearchRounds({ status: "completed", rounds: [] }),
    ).toEqual([]);
    expect(
      hostedSearchRounds({
        status: "completed",
        queries: [],
        sources: [],
      } as unknown as Parameters<typeof hostedSearchRounds>[0]),
    ).toEqual([]);
  });
});

describe("nativeWebSearchSupportedOn", () => {
  it("accepts stored apiStyle and resolved wire spellings", () => {
    expect(nativeWebSearchSupportedOn("responses")).toBe(true);
    expect(nativeWebSearchSupportedOn("anthropic_messages")).toBe(true);
    expect(nativeWebSearchSupportedOn("openai-responses")).toBe(true);
    expect(nativeWebSearchSupportedOn("azure-openai-responses")).toBe(true);
    expect(nativeWebSearchSupportedOn("anthropic-messages")).toBe(true);
    expect(nativeWebSearchSupportedOn("openai_codex_responses")).toBe(true);
    expect(nativeWebSearchSupportedOn("openai-codex-responses")).toBe(true);
  });

  it("rejects wires without a hosted search tool", () => {
    expect(nativeWebSearchSupportedOn("chat_completions")).toBe(false);
    expect(nativeWebSearchSupportedOn("openai-completions")).toBe(false);
    expect(nativeWebSearchSupportedOn(undefined)).toBe(false);
    expect(nativeWebSearchSupportedOn("")).toBe(false);
  });
});

describe("hostedSearchReplayBlocks", () => {
  it("keeps wire payloads and drops streaming scratch", () => {
    expect(
      hostedSearchReplayBlocks([
        {
          type: "hostedSearch",
          phase: "server_tool_use",
          blockId: "srvtoolu_01",
          name: "web_search",
          input: { query: "pi-desktop" },
          index: 2,
          inputJson: "{\"query\":\"pi-desktop\"}",
        },
        {
          type: "hostedSearch",
          phase: "web_search_tool_result",
          blockId: "srvtoolu_01",
          wire: {
            type: "web_search_tool_result",
            encrypted_content: "enc-1",
          },
        },
        { type: "text", text: "answer" },
      ]),
    ).toEqual([
      {
        type: "hostedSearch",
        phase: "server_tool_use",
        blockId: "srvtoolu_01",
        name: "web_search",
        input: { query: "pi-desktop" },
      },
      {
        type: "hostedSearch",
        phase: "web_search_tool_result",
        blockId: "srvtoolu_01",
        wire: {
          type: "web_search_tool_result",
          encrypted_content: "enc-1",
        },
      },
    ]);
  });

  it("ignores junk and empty input", () => {
    expect(hostedSearchReplayBlocks(undefined)).toEqual([]);
    expect(hostedSearchReplayBlocks([{ type: "hostedSearch" }])).toEqual([]);
    expect(hostedSearchReplayBlocks("nope")).toEqual([]);
  });
});

describe("hostedSearchFromMessage", () => {
  it("attaches replay next to the display rounds", () => {
    const content = [
      {
        type: "hostedSearch",
        phase: "web_search_call",
        blockId: "ws_1",
        status: "completed",
        wire: {
          type: "web_search_call",
          id: "ws_1",
          status: "completed",
          action: { type: "search", query: "q" },
        },
      },
    ];
    const search = hostedSearchFromMessage({ content });
    expect(search?.rounds).toEqual([
      { id: "ws_1", status: "completed", query: "q", sources: [] },
    ]);
    expect(search?.replay).toEqual([
      {
        type: "hostedSearch",
        phase: "web_search_call",
        blockId: "ws_1",
        status: "completed",
        wire: {
          type: "web_search_call",
          id: "ws_1",
          status: "completed",
          action: { type: "search", query: "q" },
        },
      },
    ]);
  });
});

