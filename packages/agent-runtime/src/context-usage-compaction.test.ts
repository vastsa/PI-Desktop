import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";

type WireRequest = { input: unknown[] };
type WireUsage = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: { cached_tokens: number };
};
const highUsage: WireUsage = {
  input_tokens: 80_000, output_tokens: 100, total_tokens: 20_100,
  input_tokens_details: { cached_tokens: 60_000 },
};
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function respond(response: ServerResponse, requestNumber: number, usage: WireUsage, toolFirst: boolean): void {
  const text = `Fixture reply ${requestNumber}`;
  const tool = toolFirst && requestNumber === 1;
  const args = JSON.stringify({ path: "fixture.txt" });
  const item = tool
    ? { id: `item-${requestNumber}`, type: "function_call", call_id: `call-${requestNumber}`,
        name: "Read", arguments: args, status: "completed" }
    : { id: `message-${requestNumber}`, type: "message", role: "assistant", status: "completed",
        content: [{ type: "output_text", text, annotations: [] }] };
  const events = [
    { type: "response.created", response: { id: `response-${requestNumber}` } },
    { type: "response.output_item.added", output_index: 0,
      item: tool ? { ...item, arguments: "", status: "in_progress" } : { ...item, content: [], status: "in_progress" } },
    tool
      ? { type: "response.function_call_arguments.delta", output_index: 0, delta: args }
      : { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `response-${requestNumber}`, status: "completed", output: [item],
        usage: requestNumber === 1 ? usage : { input_tokens: 10, output_tokens: 1, total_tokens: 11 },
      },
    },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
}

async function fixture(history: UiMessage[] = [], usage: WireUsage = highUsage, toolFirst = false) {
  const requests: WireRequest[] = [];
  const timeline: string[] = [];
  const events: AgentEventEnvelope[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw) as WireRequest);
    timeline.push(`request:${requests.length}`);
    respond(response, requests.length, usage, toolFirst);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const provider: RuntimeProviderConfig = {
    id: "fixture", name: "Fixture", baseUrl, modelId: "fixture-model", apiKey: "fixture-only",
    apiStyle: "responses", supportsReasoning: false, supportedThinkingLevels: ["off"],
    modelConfig: {
      source: "generic", name: "Fixture model", baseUrl, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100_000, maxTokens: 8_192,
    },
  };
  const runtime = new DesktopAgentRuntime({
    sessionId: "usage-fixture", mode: "agent", provider, history, thinkingLevel: "off",
    compactionStrategy: "fresh_window",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: {
      call: async <T>(method: string): Promise<T> => {
        if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
        if (method === "session.appendCompaction") timeline.push("checkpoint");
        else if (method === "tools.execute") {
          timeline.push("tool");
          return { ok: true, content: "Fixture result." } as T;
        } else if (method !== "session.appendMessage") throw new Error(`Unexpected host method: ${method}`);
        return undefined as T;
      },
      onNotification: () => () => {},
    },
    onEvent: (event) => events.push(event),
  });
  cleanups.push(async () => { await runtime.dispose(); });
  return { runtime, requests, timeline, events };
}

describe("reported context occupancy and compaction", () => {
  it("compacts before a new request when cached input is absent from the reported total", async () => {
    const f = await fixture();
    await f.runtime.prompt("Start the task.", "user-1", "turn-1");
    const first = f.events.find(({ event }) => event.type === "message_end" && event.message.role === "assistant");
    expect(first?.event).toMatchObject({ type: "message_end", message: { usage: {
      inputTokens: 20_000, outputTokens: 100, cacheReadTokens: 60_000, totalTokens: 20_100,
    } } });

    await f.runtime.prompt("Continue the task.", "user-2", "turn-2");

    expect(f.timeline).toEqual(["request:1", "checkpoint", "request:2"]);
    expect(f.events.some(({ event }) => event.type === "compaction_end" && event.ok)).toBe(true);
    expect(JSON.stringify(f.requests[1].input)).toContain("Continue the task.");
  });

  it("uses the same occupancy after restoring a session", async () => {
    const f = await fixture([
      { id: "old-user", role: "user", content: "Previous task.", createdAt: "2026-10-01T00:00:00Z" },
      { id: "old-answer", role: "assistant", content: "Previous response.", status: "complete",
        createdAt: "2026-10-01T00:00:01Z", usage: {
          inputTokens: 20_000, outputTokens: 100, cacheReadTokens: 60_000, totalTokens: 20_100,
        } },
    ]);

    await f.runtime.prompt("Continue the restored task.", "new-user", "new-turn");

    expect(f.timeline).toEqual(["checkpoint", "request:1"]);
    expect(f.events.some(({ event }) => event.type === "compaction_end" && event.ok)).toBe(true);
    expect(JSON.stringify(f.requests[0].input)).toContain("Continue the restored task.");
  });

  it("compacts between a tool result and the next provider request", async () => {
    const f = await fixture([], highUsage, true);

    await f.runtime.prompt("Read the fixture.", "user-1", "turn-1");

    expect(f.timeline).toEqual(["request:1", "tool", "checkpoint", "request:2"]);
    expect(f.events.some(({ event }) => event.type === "compaction_end" && event.ok)).toBe(true);
  });

  it("does not compact an under-budget request with consistent usage", async () => {
    const f = await fixture([], {
      input_tokens: 4_000, output_tokens: 10, total_tokens: 4_010,
      input_tokens_details: { cached_tokens: 2_000 },
    });

    await f.runtime.prompt("Start the task.", "user-1", "turn-1");
    await f.runtime.prompt("Continue the task.", "user-2", "turn-2");

    expect(f.timeline).toEqual(["request:1", "request:2"]);
    expect(f.events.some(({ event }) => event.type === "compaction_start")).toBe(false);
  });

  it("still compacts when only a partial bucket breakdown accompanies the total", async () => {
    const f = await fixture([], { input_tokens: 0, output_tokens: 10, total_tokens: 80_000 });

    await f.runtime.prompt("Start the task.", "user-1", "turn-1");
    await f.runtime.prompt("Continue the task.", "user-2", "turn-2");

    expect(f.timeline).toEqual(["request:1", "checkpoint", "request:2"]);
    expect(f.events.some(({ event }) => event.type === "compaction_end" && event.ok)).toBe(true);
  });
});
