/**
 * A routed-id gateway through the real agent loop.
 *
 * Eden AI is the motivating case: an OpenAI-compatible gateway at
 * `https://api.edenai.run/v3` whose model ids are `provider/model`. Nothing in
 * these tests reaches the network. `fetch` is replaced by a fixture that answers
 * the way an OpenAI-compatible Chat Completions endpoint does, and everything
 * between the agent's prompt and that fixture is production code: the provider
 * binding, pi-ai's adapter, pi-agent-core's loop, and the desktop runtime.
 *
 * What is established here is therefore what PI-Desktop sends and how it reads
 * a conforming answer. It is not evidence that Eden AI itself streams tool calls
 * this way; that remains a live check.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import { genericModelConfig } from "./model-capabilities.js";

const BASE_URL = "https://api.edenai.run/v3";
const MODEL_ID = "deepinfra/meta-llama/Llama-3.3-70B-Instruct";

const provider: RuntimeProviderConfig = {
  id: "eden-row-uuid",
  name: "Eden AI",
  vendorKey: "edenai",
  baseUrl: BASE_URL,
  modelId: MODEL_ID,
  apiKey: "eden-fixture-key",
  authKind: "api_key_and_base_url",
  apiStyle: "chat_completions",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
  modelConfig: { ...genericModelConfig(MODEL_ID, BASE_URL), contextWindow: 131_072 },
};

type Captured = { url: string; headers: Headers; body: Record<string, any> };

const chunk = (value: Record<string, unknown>, finish: string | null, extra: Record<string, unknown> = {}) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-fixture",
    object: "chat.completion.chunk",
    created: 1,
    model: MODEL_ID,
    choices: [{ index: 0, delta: value, finish_reason: finish }],
    ...extra,
  })}\n\n`;

const sse = (frames: string[]) =>
  new Response(frames.join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });

/** The tool-call answer, streamed the way OpenAI-compatible gateways stream it. */
function toolCallAnswer(): Response {
  return sse([
    chunk({ role: "assistant", content: "" }, null),
    // The tool call arrives as a start frame and then argument fragments that
    // are only valid JSON once concatenated.
    chunk({ tool_calls: [{ index: 0, id: "call_fixture_1", type: "function", function: { name: "Read", arguments: "" } }] }, null),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] }, null),
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"fixt' } }] }, null),
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'ure.txt"}' } }] }, null),
    chunk({}, "tool_calls"),
    // Usage rides on a trailing chunk with no choices, as `stream_options.include_usage` specifies.
    `data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: MODEL_ID, choices: [], usage: { prompt_tokens: 41, completion_tokens: 9, total_tokens: 50 } })}\n\n`,
  ]);
}

function textAnswer(text: string): Response {
  return sse([
    chunk({ role: "assistant", content: text }, null),
    chunk({}, "stop", { usage: { prompt_tokens: 63, completion_tokens: 4, total_tokens: 67 } }),
  ]);
}

/** Real provider adapter and agent loop; only fetch and the host edge are replaced. */
function fixture(answers: Array<() => Response>) {
  const captured: Captured[] = [];
  const events: AgentEventEnvelope[] = [];
  let reads = 0;
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    captured.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    const answer = answers[captured.length - 1];
    if (!answer) throw new Error("Unexpected provider request");
    return answer();
  });
  vi.stubGlobal("fetch", fetch);
  const runtime = new DesktopAgentRuntime({
    sessionId: "gateway-fixture-session",
    mode: "agent",
    provider,
    thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    host: {
      async call<T>(method: string): Promise<T> {
        if (method !== "tools.execute") throw new Error(`Unexpected host method: ${method}`);
        reads++;
        return { ok: true, content: "fixture contents" } as T;
      },
    },
    onEvent: (event) => events.push(event),
  });
  return { runtime, captured, events, reads: () => reads };
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const observed = promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  void observed.then(() => {
    settled = true;
  });
  for (let tick = 0; tick < 180 && !settled; tick++) await vi.advanceTimersByTimeAsync(1000);
  expect(settled, "run settles inside the bounded recovery window").toBe(true);
  const result = await observed;
  if ("error" in result) throw result.error;
  return result.value;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("OpenAI-compatible gateway with routed model ids (Eden AI shape)", () => {
  it("streams a tool call, runs the tool, replays the result and finishes with usage", async () => {
    vi.useFakeTimers();
    const f = fixture([toolCallAnswer, () => textAnswer("fixture.txt says: fixture contents")]);
    try {
      await settle(f.runtime.prompt("Read fixture.txt and report its contents."));

      // Request 1: the routed id is sent verbatim to the gateway's chat route.
      expect(f.captured).toHaveLength(2);
      const [first, second] = f.captured;
      expect(first.url).toBe(`${BASE_URL}/chat/completions`);
      expect(first.headers.get("authorization")).toBe("Bearer eden-fixture-key");
      expect(first.body.model).toBe(MODEL_ID);
      expect(first.body.stream).toBe(true);
      expect(first.body.stream_options).toEqual({ include_usage: true });
      expect(first.body.messages[0]).toMatchObject({ role: "system" });
      expect(first.body.tools.map((tool: any) => tool.function.name)).toContain("Read");

      // The fragments were accumulated into one argument object and the tool ran once.
      expect(f.reads()).toBe(1);

      // Request 2 replays the assistant tool call and the tool result by id.
      const assistantTurn = second.body.messages.find((m: any) => m.role === "assistant" && m.tool_calls);
      expect(assistantTurn.tool_calls[0]).toMatchObject({
        id: "call_fixture_1",
        type: "function",
        function: { name: "Read", arguments: '{"path":"fixture.txt"}' },
      });
      const toolResult = second.body.messages.find((m: any) => m.role === "tool");
      expect(toolResult).toMatchObject({ tool_call_id: "call_fixture_1" });
      expect(String(toolResult.content)).toContain("fixture contents");

      // The final assistant message completed, and both gateway usage chunks
      // (the trailing choices-less one and the one on the stop frame) were read.
      const ends = f.events.flatMap((e) => (e.event.type === "message_end" ? [e.event] : []));
      const final = ends.at(-1) as any;
      expect(final.message.status).toBe("complete");
      expect(final.message.content).toBe("fixture.txt says: fixture contents");
      const usage = f.events.flatMap((e) => (e.event.type === "usage" ? [e.event.usage as any] : []));
      expect(usage.length).toBeGreaterThanOrEqual(2);
      expect(usage.map((u) => [u.input ?? u.inputTokens, u.output ?? u.outputTokens])).toEqual(
        expect.arrayContaining([[41, 9], [63, 4]]),
      );
      expect(f.events.filter((e) => e.event.type === "error")).toHaveLength(0);
    } finally {
      await f.runtime.dispose();
    }
  });

  it("does not execute a tool from a stream that dies before the call is complete", async () => {
    vi.useFakeTimers();
    const truncated = () => {
      let sent = 0;
      const frames = [
        chunk({ role: "assistant", content: "" }, null),
        chunk({ tool_calls: [{ index: 0, id: "call_fixture_2", type: "function", function: { name: "Read", arguments: '{"pa' } }] }, null),
      ];
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent < frames.length) controller.enqueue(new TextEncoder().encode(frames[sent++]));
            else controller.error(new Error("terminated"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    // Every attempt dies mid-call; the bounded retry budget must end the turn.
    const f = fixture(Array.from({ length: 12 }, () => truncated));
    try {
      await settle(f.runtime.prompt("Read fixture.txt."));
      expect(f.reads()).toBe(0);
      const errors = f.events.filter((e) => e.event.type === "error");
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(f.events.filter((e) => e.event.type === "agent_end")).toHaveLength(1);
    } finally {
      await f.runtime.dispose();
    }
  });

  it("surfaces a malformed stream frame as a provider error instead of a phantom tool call", async () => {
    vi.useFakeTimers();
    const malformed = () =>
      new Response(
        chunk({ role: "assistant", content: "" }, null) + "data: {not json\n\n" + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    const f = fixture(Array.from({ length: 12 }, () => malformed));
    try {
      await settle(f.runtime.prompt("Report."));
      expect(f.reads()).toBe(0);
      expect(f.events.some((e) => e.event.type === "error")).toBe(true);
      expect(f.events.filter((e) => e.event.type === "agent_end")).toHaveLength(1);
    } finally {
      await f.runtime.dispose();
    }
  });
});
