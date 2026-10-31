import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { CommandShellOption, UiMessage } from "@pi-desktop/shared";

import {
  MAX_PROVIDER_REPLAY_BYTES,
  captureAssistantProviderReplay,
  providerReplayForBubble,
  providerReplayToolCallSignatures,
  restoreAssistantProviderReplay,
} from "./assistant-provider-replay.js";
import { assistantContent } from "./agent-messages.js";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";

/**
 * A rebuilt runtime replays persisted rows. Without the provider signatures,
 * pi-ai sends Anthropic thinking as plain text and drops Responses reasoning
 * items, which rewrites the request prefix and loses the prompt cache (#1972).
 */

const signedContent: AssistantMessage["content"] = [
  { type: "thinking", thinking: "plan A", thinkingSignature: "sig-1" },
  { type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
  { type: "text", text: "Hello ", textSignature: "msg-1" },
  { type: "thinking", thinking: "plan B", thinkingSignature: "sig-2" },
  { type: "text", text: "world" },
];

describe("assistant provider replay", () => {
  it("restores the exact signed blocks from the persisted text", () => {
    const replay = captureAssistantProviderReplay(signedContent);
    const { text, thinking } = assistantContent(signedContent);
    // The row keeps boundaries and signatures only, never the texts.
    expect(JSON.stringify(replay)).not.toContain("plan A");
    expect(restoreAssistantProviderReplay(replay, thinking, text)).toEqual([
      { type: "thinking", thinking: "plan A", thinkingSignature: "sig-1" },
      { type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true },
      { type: "text", text: "Hello ", textSignature: "msg-1" },
      { type: "thinking", thinking: "plan B", thinkingSignature: "sig-2" },
      { type: "text", text: "world" },
    ]);
  });

  it("records nothing when no block carries a signature", () => {
    expect(
      captureAssistantProviderReplay([
        { type: "thinking", thinking: "plain" },
        { type: "text", text: "answer" },
      ]),
    ).toBeUndefined();
    expect(captureAssistantProviderReplay("text only")).toBeUndefined();
  });

  it("links function-call signatures by call id", () => {
    const replay = captureAssistantProviderReplay([
      { type: "toolCall", id: "call-1", name: "Read", arguments: {}, thoughtSignature: "fc-1" },
      { type: "toolCall", id: "call-2", name: "Read", arguments: {} },
    ]);
    expect(replay).toEqual({ version: 1, blocks: [], toolCalls: [{ id: "call-1", signature: "fc-1" }] });
    expect([...providerReplayToolCallSignatures(replay)]).toEqual([["call-1", "fc-1"]]);
    expect(providerReplayToolCallSignatures({ version: 2, toolCalls: [{ id: "a", signature: "b" }] }).size).toBe(0);
  });

  it("drops the replay data of a row above the size ceiling", () => {
    const huge = "x".repeat(MAX_PROVIDER_REPLAY_BYTES);
    expect(
      captureAssistantProviderReplay([{ type: "thinking", thinking: "", thinkingSignature: huge, redacted: true }]),
    ).toBeUndefined();
    expect(
      captureAssistantProviderReplay([{ type: "thinking", thinking: "t", thinkingSignature: "small" }]),
    ).toBeDefined();
  });

  it("keeps only call signatures when the bubble text is not this response's", () => {
    const replay = captureAssistantProviderReplay([
      { type: "thinking", thinking: "t", thinkingSignature: "th" },
      { type: "toolCall", id: "call-1", name: "Read", arguments: {}, thoughtSignature: "fc-1" },
    ]);
    expect(providerReplayForBubble(replay, true)).toBe(replay);
    expect(providerReplayForBubble(replay, false)).toEqual({
      version: 1,
      blocks: [],
      toolCalls: [{ id: "call-1", signature: "fc-1" }],
    });
    expect(
      providerReplayForBubble(captureAssistantProviderReplay([{ type: "text", text: "a", textSignature: "m" }]), false),
    ).toBeUndefined();
  });

  it("falls back when the stored lengths no longer match the row", () => {
    const replay = captureAssistantProviderReplay(signedContent);
    expect(restoreAssistantProviderReplay(replay, "plan Aplan B", "Hello world!")).toBeUndefined();
    expect(restoreAssistantProviderReplay(replay, "edited", "Hello world")).toBeUndefined();
    expect(restoreAssistantProviderReplay(undefined, "", "")).toBeUndefined();
    expect(restoreAssistantProviderReplay({ version: 2, blocks: [] }, "", "")).toBeUndefined();
    expect(
      restoreAssistantProviderReplay(
        { version: 1, blocks: [{ type: "text", length: -1 }] },
        "",
        "",
      ),
    ).toBeUndefined();
  });
});

const commandShell: CommandShellOption = {
  id: "bash",
  label: "Bash",
  dialect: "posix",
  available: true,
  isDefault: true,
};

const responsesProvider: RuntimeProviderConfig = {
  id: "relay",
  name: "Relay",
  baseUrl: "https://relay.example.com/v1",
  modelId: "gpt-test",
  apiKey: "sk-test",
  authKind: "none",
  supportsReasoning: true,
  supportedThinkingLevels: ["off", "medium"],
  modelConfig: {
    source: "generic",
    api: "responses",
    name: "GPT Test",
    baseUrl: "https://relay.example.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
};

const reasoningItem = {
  type: "reasoning",
  id: "rs_1",
  summary: [{ type: "summary_text", text: "think" }],
  encrypted_content: "enc-1",
};

function historyRow(overrides: Partial<UiMessage> = {}): UiMessage[] {
  const live: AssistantMessage["content"] = [
    { type: "thinking", thinking: "think", thinkingSignature: JSON.stringify(reasoningItem) },
    {
      type: "text",
      text: "answer",
      textSignature: JSON.stringify({ v: 1, id: "msg_real_1" }),
    },
  ];
  return [
    { id: "u1", role: "user", content: "question", createdAt: "2026-01-01T00:00:00.000Z" },
    {
      id: "a1",
      role: "assistant",
      content: "answer",
      thinking: "think",
      createdAt: "2026-01-01T00:00:01.000Z",
      status: "complete",
      providerReplay: captureAssistantProviderReplay(live),
      ...overrides,
    },
  ];
}

function createRuntime(history: UiMessage[], onEvent = vi.fn()) {
  return new DesktopAgentRuntime({
    host: {
      call: vi.fn(async () => ({})),
      onNotification: vi.fn(() => () => {}),
    } as never,
    sessionId: "session-1",
    mode: "agent",
    provider: responsesProvider,
    thinkingLevel: "medium",
    commandShell,
    history,
    onEvent,
  });
}

async function firstRequestInput(history: UiMessage[]): Promise<unknown[]> {
  const runtime = createRuntime(history);
  const internals = runtime as unknown as {
    agent: Agent;
    model: Model<Api>;
    fullEntries: { message: unknown }[];
  };
  const bodies: Record<string, unknown>[] = [];
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ error: { message: "fixture" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  };
  const messages = [
    ...internals.fullEntries.map((entry) => entry.message),
    { role: "user", content: "next", timestamp: 2 },
  ];
  const stream = await internals.agent.streamFunction(
    internals.model,
    { messages } as never,
    { apiKey: "sk-test", fetch },
  );
  // The fixture fails the request; only the captured body is under test.
  await stream.result().catch(() => undefined);
  await runtime.dispose();
  expect(bodies).toHaveLength(1);
  return bodies[0].input as unknown[];
}

describe("rebuilt runtime request", () => {
  it("replays the persisted reasoning item and message id", async () => {
    const input = await firstRequestInput(historyRow());
    expect(input).toContainEqual(expect.objectContaining({ type: "reasoning", id: "rs_1", encrypted_content: "enc-1" }));
    expect(input).toContainEqual(expect.objectContaining({ type: "message", role: "assistant", id: "msg_real_1" }));
  });

  it("keeps the previous rebuild for rows without replay data", async () => {
    const input = await firstRequestInput(historyRow({ providerReplay: undefined }));
    expect(input.some((item) => (item as { type?: string }).type === "reasoning")).toBe(false);
    expect(input).toContainEqual(expect.objectContaining({ type: "message", role: "assistant", id: "msg_pi_1" }));
  });
});

describe("live response to rebuilt request", () => {
  it("persists the replay data a later runtime needs", async () => {
    const onEvent = vi.fn();
    const live = createRuntime([], onEvent);
    const handleAgentEvent = (live as unknown as {
      handleAgentEvent: (event: unknown) => Promise<void>;
    }).handleAgentEvent.bind(live);
    const message = {
      role: "assistant",
      content: [] as AssistantMessage["content"],
      api: "openai-responses",
      provider: "relay",
      model: "gpt-test",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1,
    };
    await handleAgentEvent({ type: "message_start", message });
    await handleAgentEvent({
      type: "message_end",
      message: {
        ...message,
        content: [
          { type: "thinking", thinking: "think", thinkingSignature: JSON.stringify(reasoningItem) },
          { type: "text", text: "answer", textSignature: JSON.stringify({ v: 1, id: "msg_real_1" }) },
        ],
      },
    });
    await live.dispose();

    const ended = onEvent.mock.calls
      .map(([envelope]) => (envelope as { event: { type: string; message?: UiMessage } }).event)
      .find((event) => event.type === "message_end" && event.message?.role === "assistant");
    expect(ended?.message?.providerReplay).toBeDefined();

    // What the host stores is JSON; restore from that, not the live object.
    const persisted = JSON.parse(JSON.stringify(ended?.message)) as UiMessage;
    const input = await firstRequestInput([
      { id: "u1", role: "user", content: "question", createdAt: "2026-01-01T00:00:00.000Z" },
      persisted,
    ]);
    expect(input).toContainEqual(expect.objectContaining({ type: "reasoning", encrypted_content: "enc-1" }));
    expect(input).toContainEqual(expect.objectContaining({ type: "message", role: "assistant", id: "msg_real_1" }));
  });
});

/**
 * Gemini signs function calls separately from thinking (`thoughtSignature` on
 * the functionCall part). The call is rebuilt from its tool row, so the
 * signature has to come back from the assistant row's replay data.
 */
describe("Gemini function-call signatures across a rebuild", () => {
  const googleProvider: RuntimeProviderConfig = {
    id: "google",
    name: "Google Gemini",
    vendorKey: "google",
    apiStyle: "google_generative_ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    modelId: "gemini-3.8-flash",
    apiKey: "AIza-test",
    authKind: "api_key",
    supportsReasoning: true,
    supportedThinkingLevels: ["off", "high"],
  };

  type GooglePart = Record<string, unknown>;
  type GoogleContent = { role: string; parts: GooglePart[] };

  function googleRuntime(history: UiMessage[], onEvent = vi.fn()) {
    return new DesktopAgentRuntime({
      host: {
        call: vi.fn(async () => ({})),
        onNotification: vi.fn(() => () => {}),
      } as never,
      sessionId: "session-g",
      mode: "agent",
      provider: googleProvider,
      thinkingLevel: "high",
      commandShell,
      history,
      onEvent,
    });
  }

  // The Google adapter only accepts the global fetch (#1072).
  async function requestContents(
    runtime: DesktopAgentRuntime,
    messages: unknown[],
  ): Promise<GoogleContent[]> {
    const internals = runtime as unknown as { agent: Agent; model: Model<Api> };
    const bodies: { contents: GoogleContent[] }[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      // A short successful stream: a failed request would be retried.
      const chunk = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`;
      return new Response(
        chunk({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, index: 0 }] }) +
          chunk({
            candidates: [{ content: { role: "model", parts: [] }, finishReason: "STOP", index: 0 }],
            usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
          }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    try {
      const stream = await internals.agent.streamFunction(
        internals.model,
        { messages: [...messages, { role: "user", content: "next", timestamp: 9 }] } as never,
        { apiKey: "AIza-test" },
      );
      await stream.result();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(bodies).toHaveLength(1);
    return bodies[0].contents;
  }

  /**
   * Runs one live call-making turn, persists what the Host would (the
   * assistant row from message_end, tool rows from tool_start/tool_end, all
   * as JSON), then compares the live and rebuilt requests.
   */
  async function liveAndRebuilt(content: AssistantMessage["content"]) {
    const onEvent = vi.fn();
    const live = googleRuntime([], onEvent);
    const internals = live as unknown as {
      model: Model<Api>;
      handleAgentEvent: (event: unknown) => Promise<void>;
    };
    const handle = internals.handleAgentEvent.bind(live);
    const message = {
      role: "assistant",
      content: [] as AssistantMessage["content"],
      api: internals.model.api,
      provider: internals.model.provider,
      model: internals.model.id,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 2,
    };
    const finished = { ...message, content } as AssistantMessage;
    await handle({ type: "message_start", message });
    await handle({ type: "message_end", message: finished });
    const calls = content.filter((block) => block.type === "toolCall");
    const results = calls.map((call, index) => ({
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: `result ${index + 1}` }],
      details: undefined,
      isError: false,
      timestamp: 3 + index,
    }));
    for (const [index, call] of calls.entries()) {
      await handle({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
      await handle({
        type: "tool_execution_end",
        toolCallId: call.id,
        toolName: call.name,
        result: results[index].content[0].text,
        isError: false,
      });
    }
    const user = { role: "user" as const, content: "question", timestamp: 1 };
    const liveContents = await requestContents(live, [user, finished, ...results]);
    await live.dispose();

    const events = onEvent.mock.calls.map(
      ([envelope]) => (envelope as { event: Record<string, any> }).event,
    );
    const assistantRow = events.find(
      (event) => event.type === "message_end" && event.message?.role === "assistant",
    )?.message as UiMessage;
    // Host-built tool rows (packages/host-runtime turn-events tool_end).
    const toolRows: UiMessage[] = calls.map((call, index) => {
      const end = events.find((event) => event.type === "tool_end" && event.toolCallId === call.id);
      return {
        id: call.id,
        role: "tool",
        content: "",
        createdAt: `2026-01-01T00:00:0${3 + index}.000Z`,
        toolCallId: call.id,
        toolName: call.name,
        toolArgs: call.arguments,
        toolResult: end?.result,
        toolStatus: "success",
      };
    });
    const history = JSON.parse(JSON.stringify([
      { id: "u1", role: "user", content: "question", createdAt: "2026-01-01T00:00:01.000Z" },
      { ...assistantRow, createdAt: "2026-01-01T00:00:02.000Z" },
      ...toolRows,
    ])) as UiMessage[];
    const rebuilt = googleRuntime(history);
    const rebuiltInternals = rebuilt as unknown as { fullEntries: { message: unknown }[] };
    const rebuiltContents = await requestContents(
      rebuilt,
      rebuiltInternals.fullEntries.map((entry) => entry.message),
    );
    await rebuilt.dispose();
    return { liveContents, rebuiltContents, assistantRow };
  }

  const modelParts = (contents: GoogleContent[]) =>
    contents.find((entry) => entry.role === "model")?.parts ?? [];
  const responseParts = (contents: GoogleContent[]) =>
    contents
      .filter((entry) => entry.role === "user")
      .flatMap((entry) => entry.parts)
      .filter((part) => "functionResponse" in part)
      .map((part) => {
        const response = part.functionResponse as { name: string; id?: string };
        return { name: response.name, id: response.id };
      });

  it("restores a signature carried only by the function call", async () => {
    const { liveContents, rebuiltContents, assistantRow } = await liveAndRebuilt([
      { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "a.ts" }, thoughtSignature: "ZmMtc2lnLTE=" },
      { type: "toolCall", id: "call-2", name: "Grep", arguments: { pattern: "x" } },
    ]);
    expect(assistantRow.providerReplay?.toolCalls).toEqual([{ id: "call-1", signature: "ZmMtc2lnLTE=" }]);
    const parts = modelParts(rebuiltContents);
    expect(parts.map((part) => (part.functionCall as { name: string }).name)).toEqual(["Read", "Grep"]);
    expect(parts[0].thoughtSignature).toBe("ZmMtc2lnLTE=");
    expect(parts[1].thoughtSignature).toBeUndefined();
    expect(parts).toEqual(modelParts(liveContents));
    expect(responseParts(rebuiltContents)).toEqual(responseParts(liveContents));
    expect(responseParts(rebuiltContents).map((part) => part.name)).toEqual(["Read", "Grep"]);
  });

  it("restores thinking and function-call signatures together", async () => {
    const { liveContents, rebuiltContents } = await liveAndRebuilt([
      { type: "thinking", thinking: "look first", thinkingSignature: "dGgtc2ln" },
      { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "a.ts" }, thoughtSignature: "ZmMtc2lnLTE=" },
      { type: "toolCall", id: "call-2", name: "Grep", arguments: { pattern: "x" }, thoughtSignature: "ZmMtc2lnLTI=" },
    ]);
    const parts = modelParts(rebuiltContents);
    expect(parts[0]).toMatchObject({ thought: true, thoughtSignature: "dGgtc2ln" });
    expect(parts.slice(1).map((part) => part.thoughtSignature)).toEqual(["ZmMtc2lnLTE=", "ZmMtc2lnLTI="]);
    expect(parts).toEqual(modelParts(liveContents));
    expect(responseParts(rebuiltContents)).toEqual(responseParts(liveContents));
  });
});
