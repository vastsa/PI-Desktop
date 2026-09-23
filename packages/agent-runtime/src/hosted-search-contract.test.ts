import { describe, expect, it } from "vitest";

import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * Contract tests for the pi-ai hosted web search patch.
 *
 * The patch (patches/@earendil-works__pi-ai@0.87.1.patch) teaches the
 * anthropic-messages and openai-responses adapters to attach the provider
 * hosted web search tool when the model record opts in, to extract the search
 * blocks and citations from the stream, and to replay the search items on
 * later turns. These tests drive the exported stream processor with
 * synthetic provider events — including malformed ones — so the extraction
 * contract is locked without hitting a real provider.
 */

type AnyRecord = Record<string, unknown>;

async function processEvents(events: AnyRecord[]): Promise<{
  output: AssistantMessage & {
    hostedSearchCitations?: { url: string; title?: string }[];
  };
  stream: AnyRecord[];
}> {
  const { processResponsesStream } = await import("@earendil-works/pi-ai/api/openai-responses-shared");
  const output = {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
  const stream: AnyRecord[] = [];
  const model = {
    id: "gpt-test",
    api: "openai-responses",
    provider: "openai",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  } as never;
  const sink = {
    push: (event: AnyRecord) => stream.push(event),
  } as unknown as Parameters<typeof processResponsesStream>[2];
  const asyncEvents = (async function* () {
    for (const event of events) yield event;
  })();
  await processResponsesStream(
    asyncEvents as never,
    output as unknown as AssistantMessage,
    sink,
    model,
    {},
  );
  return { output: output as unknown as AssistantMessage & {
    hostedSearchCitations?: { url: string; title?: string }[];
  }, stream };
}

describe("pi-ai hosted web search: responses stream extraction", () => {
  it("captures a web_search_call as a hostedSearch content block", async () => {
    const { output } = await processEvents([
      {
        type: "response.created",
        response: { id: "resp_1" },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "web_search_call",
          id: "ws_1",
          status: "in_progress",
          action: { type: "search", query: "pi-desktop release notes" },
        },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "message", id: "msg_1", role: "assistant" },
      },
      {
        type: "response.output_text.delta",
        output_index: 1,
        delta: "Found it.",
      },
      {
        type: "response.output_text.annotation.added",
        output_index: 1,
        annotation: {
          type: "url_citation",
          url: "https://example.com/release",
          title: "Release notes",
          start_index: 0,
          end_index: 5,
        },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "web_search_call",
          id: "ws_1",
          status: "completed",
          action: { type: "search", query: "pi-desktop release notes" },
        },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Found it.", annotations: [] }],
        },
      },
      {
        type: "response.completed",
        response: { id: "resp_1", usage: {} },
      },
    ]);

    const search = output.content.find(
      (block) => ((block ?? {}) as unknown as AnyRecord).type === "hostedSearch",
    ) as unknown as AnyRecord | undefined;
    expect(search).toBeDefined();
    expect(search?.phase).toBe("web_search_call");
    expect(search?.status).toBe("completed");
    expect((((search ?? {}) as AnyRecord).wire as AnyRecord)?.action).toMatchObject({
      type: "search",
      query: "pi-desktop release notes",
    });

    const citations = (output as unknown as AnyRecord).hostedSearchCitations as
    AnyRecord[] | undefined;
    expect(citations).toEqual([
      { url: "https://example.com/release", title: "Release notes" },
    ]);
  });

  it("ignores malformed annotations and unknown web_search_call shapes", async () => {
    const { output } = await processEvents([
      {
        type: "response.output_text.annotation.added",
        output_index: 0,
        // Missing url: dropped rather than crashing the turn.
        annotation: { type: "url_citation", title: "no url" },
      },
      {
        type: "response.output_text.annotation.added",
        output_index: 0,
        annotation: { type: "something_else", url: "https://example.com" },
      },
      {
        type: "response.web_search_call.completed",
        // No item payload: nothing to slot, and no error.
        output_index: 3,
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "message", id: "msg_1", role: "assistant" },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          id: "msg_1",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "ok", annotations: [] }],
        },
      },
      {
        type: "response.completed",
        response: { id: "resp_2", usage: {} },
      },
    ]);

    expect((output as unknown as AnyRecord).hostedSearchCitations).toBeUndefined();
    expect(
      output.content.filter((b) => ((b ?? {}) as unknown as AnyRecord).type === "hostedSearch"),
    ).toHaveLength(0);
    expect(
      output.content.find((b) => ((b ?? {}) as unknown as AnyRecord).type === "text"),
    ).toMatchObject({ text: "ok" });
  });
});

describe("pi-ai hosted web search: responses message replay", () => {
  it("replays a hostedSearch block as a web_search_call output item", async () => {
    const { convertResponsesMessages } = await import("@earendil-works/pi-ai/api/openai-responses-shared");
    const model = {
      id: "gpt-test",
      api: "openai-responses",
      provider: "openai",
      input: ["text"],
    } as unknown as Parameters<typeof convertResponsesMessages>[1];
    const context = {
      messages: [
        {
          role: "user",
          content: "search for the release notes",
        },
        {
          role: "assistant",
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
              },
            },
            { type: "text", text: "Found it." },
          ],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-test",
        },
      ],
    } as unknown as Parameters<typeof convertResponsesMessages>[2];

    const replay = convertResponsesMessages(
      model as never,
      context as never,
      new Set<string>(),
      {},
    ) as unknown as AnyRecord[];

    const searchItem = replay.find(
      (item) => item.type === "web_search_call",
    ) as unknown as AnyRecord | undefined;
    expect(searchItem).toBeDefined();
    expect(searchItem?.id).toBe("ws_1");
    expect(searchItem?.status).toBe("completed");
    expect((searchItem?.action as AnyRecord)?.query).toBe(
      "pi-desktop release notes",
    );
  });

  it("replays an Anthropic search error with its error block type", async () => {
    const { streamSimple } = await import("@earendil-works/pi-ai/api/anthropic-messages");
    let request: AnyRecord | undefined;
    const context = {
      messages: [
        { role: "user", content: "search again", timestamp: 1 },
        {
          role: "assistant",
          content: [
            {
              type: "hostedSearch",
              phase: "server_tool_use",
              blockId: "srv_1",
              name: "web_search",
              input: { query: "release notes" },
            },
            {
              type: "hostedSearch",
              phase: "web_search_tool_result",
              blockId: "srv_1",
              isError: true,
              wire: {
                type: "web_search_tool_result_error",
                tool_use_id: "srv_1",
                content: "search unavailable",
              },
            },
          ],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-test",
          timestamp: 2,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      ],
    };
    const sse =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","content":[],"model":"claude-test","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';
    const stream = streamSimple(
      {
        id: "claude-test",
        api: "anthropic-messages",
        provider: "anthropic",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 1_000,
        baseUrl: "http://localhost",
      } as never,
      context as never,
      {
        apiKey: "test",
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          request = JSON.parse(String(init?.body));
          return new Response(sse, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }) as never,
      } as never,
    );
    await stream.result();
    const messages = Array.isArray(request?.messages)
      ? (request.messages as AnyRecord[])
      : [];
    const assistant = messages.find(
      (message: AnyRecord) => message.role === "assistant",
    );
    expect(assistant?.content).toEqual([
      { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: "release notes" } },
      {
        type: "web_search_tool_result_error",
        tool_use_id: "srv_1",
        content: "search unavailable",
      },
    ]);
  });
});

describe("pi-ai hosted web search: streaming progress events", () => {
  it("emits hosted_search_update as each round starts and finishes", async () => {
    const { output, stream } = await processEvents([
      { type: "response.created", response: { id: "resp_1" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "web_search_call",
          id: "ws_1",
          status: "in_progress",
          action: { type: "search", query: "first query" },
        },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          type: "web_search_call",
          id: "ws_2",
          status: "in_progress",
          action: { type: "search", query: "second query" },
        },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "web_search_call",
          id: "ws_1",
          status: "completed",
          action: { type: "search", query: "first query" },
        },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "web_search_call",
          id: "ws_2",
          status: "completed",
          action: { type: "search", query: "second query" },
        },
      },
      { type: "response.completed", response: { id: "resp_1", usage: {} } },
    ]);

    // Each round is its own block, in provider order.
    const blocks = output.content.filter(
      (block) => ((block ?? {}) as unknown as AnyRecord).type === "hostedSearch",
    ) as unknown as AnyRecord[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.blockId).toBe("ws_1");
    expect(blocks[1]?.blockId).toBe("ws_2");
    expect(blocks[0]?.status).toBe("completed");
    expect(blocks[1]?.status).toBe("completed");

    // Two starts + two finishes: progress reaches the consumer per round.
    const updates = stream.filter((event) => event.type === "hosted_search_update");
    expect(updates).toHaveLength(4);
    expect(updates.map((event) => event.contentIndex)).toEqual([0, 1, 0, 1]);
  });
});

describe("pi-agent-core hosted web search forwarding", () => {
  it("forwards hosted_search_update as message_update", async () => {
    // Locks the agent-loop patch (patches/@earendil-works__pi-agent-core@0.87.1.patch):
    // without it the loop's switch drops the event and search rounds render only
    // after the whole turn finishes.
    const { agentLoop } = await import("@earendil-works/pi-agent-core");

    const partial = {
      role: "assistant",
      content: [
        {
          type: "hostedSearch",
          phase: "web_search_call",
          blockId: "ws_1",
          status: "in_progress",
          wire: { type: "web_search_call", id: "ws_1", status: "in_progress" },
        },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-test",
      stopReason: "pending",
      usage: {},
      timestamp: Date.now(),
    };
    const finalMessage = {
      ...partial,
      stopReason: "stop",
      content: [
        { ...partial.content[0], status: "completed" },
        { type: "text", text: "done" },
      ],
    };
    const streamEvents = [
      { type: "start", partial },
      { type: "hosted_search_update", contentIndex: 0, partial },
      { type: "done" },
    ];
    const streamFn = () => {
      const iterable = (async function* () {
        for (const event of streamEvents) yield event;
      })();
      return Object.assign(iterable, {
        result: async () => finalMessage,
      });
    };

    const emitted: AnyRecord[] = [];
    const agentStream = agentLoop(
      [{ role: "user", content: "search please", timestamp: Date.now() }],
      { messages: [{ role: "system", content: "", timestamp: Date.now() }], tools: [] },
      {
        model: {
          id: "gpt-test",
          api: "openai-responses",
          provider: "openai",
        },
        convertToLlm: async (messages: unknown) => messages,
      } as never,
      new AbortController().signal,
      streamFn as never,
    );
    for await (const event of agentStream as AsyncIterable<AnyRecord>) {
      emitted.push(event);
    }

    const updates = emitted.filter((event) => event.type === "message_update");
    expect(updates).toHaveLength(1);
    const message = updates[0]?.message as AnyRecord;
    expect((message.content as AnyRecord[])[0]).toMatchObject({
      type: "hostedSearch",
      blockId: "ws_1",
    });
    expect(emitted.some((event) => event.type === "message_end")).toBe(true);
  });
});

describe("pi-ai hosted web search: request params", () => {
  async function captureParams(model: AnyRecord, options: AnyRecord = {}): Promise<AnyRecord> {
    const { streamSimple } = await import("@earendil-works/pi-ai/api/openai-responses");
    let payload: AnyRecord | undefined;
    const sse =
      "event: response.completed\n" +
      'data: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n';
    const stream = streamSimple(
      {
        id: "kimi-k2.8",
        api: "openai-responses",
        provider: "self",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
        baseUrl: "http://localhost/v1",
        ...model,
      } as never,
      { messages: [] } as never,
      {
        apiKey: "test",
        onPayload: (params: AnyRecord) => {
          payload = params;
        },
        fetch: (async () =>
          new Response(sse, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          })) as never,
        ...options,
      } as never,
    );
    const result = await stream.result();
    expect(result.stopReason).toBe("stop");
    expect(payload).toBeDefined();
    return payload!;
  }

  it("attaches the search tool and asks for action sources", async () => {
    const params = await captureParams({ webSearch: true });
    expect(params.tools).toEqual([{ type: "web_search" }]);
    expect(params.include).toEqual(["web_search_call.action.sources"]);
  });

  it("merges the sources include with the reasoning include", async () => {
    // Any explicit effort arms the reasoning branch, which assigns
    // `params.include` outright — the merge must survive that.
    const params = await captureParams(
      { webSearch: true, thinkingLevelMap: { high: "high" } },
      { reasoning: "high" },
    );
    expect(params.include).toEqual(
      expect.arrayContaining([
        "reasoning.encrypted_content",
        "web_search_call.action.sources",
      ]),
    );
    expect((params.reasoning as AnyRecord)?.effort).toBe("high");
  });

});
