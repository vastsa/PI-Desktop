import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeContext, type Message } from "@earendil-works/pi-ai";
import type { UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import { subagentModelBinding } from "./subagent-model-binding.js";

/**
 * A long session rewrites a large instruction section many times. A gateway
 * without mid-conversation system support receives only the current
 * instructions, so the output budget must be measured against that request,
 * not against every superseded snapshot kept in the transcript.
 */

const WINDOW = 128_000;
const OUTPUT = 8_192;
const UPDATES = 20;
/** Each snapshot alone is ~6k tokens; all of them together exceed the window. */
const SECTION_CHARS = 25_000;

type WireItem = { role?: string; type?: string; content?: unknown };
type WireRequest = { max_output_tokens?: number; input: WireItem[] };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function section(index: number): string {
  return `update-${index}:`.padEnd(SECTION_CHARS, "x");
}

function respond(res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (data: { type: string; [key: string]: unknown }) =>
    res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  const item = {
    id: "msg_fixture", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "Continuing.", annotations: [] }],
  };
  send({ type: "response.created", response: { id: "resp_fixture" } });
  send({ type: "response.output_item.added", output_index: 0, item: { ...item, content: [], status: "in_progress" } });
  send({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "Continuing." });
  send({ type: "response.output_item.done", output_index: 0, item });
  send({
    type: "response.completed",
    response: {
      id: "resp_fixture", status: "completed", output: [item],
      usage: {
        input_tokens: 10, output_tokens: 2, total_tokens: 12,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
      },
    },
  });
  res.end();
}

async function gateway(): Promise<{ baseUrl: string; requests: WireRequest[] }> {
  const requests: WireRequest[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    requests.push(JSON.parse(raw) as WireRequest);
    respond(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address missing");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

/** A user-configured Responses gateway: mid-conversation system support is unverified. */
function gatewayProvider(baseUrl: string): RuntimeProviderConfig {
  return {
    id: "gateway", name: "Gateway", baseUrl, modelId: "gateway-model", apiKey: "fixture-not-real",
    apiStyle: "responses", supportsReasoning: false, supportedThinkingLevels: ["off"],
    modelConfig: {
      source: "generic", name: "Gateway model", baseUrl, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: WINDOW, maxTokens: OUTPUT,
    },
  };
}

function instructionItems(request: WireRequest): WireItem[] {
  return request.input.filter((item) => item.role === "system" || item.role === "developer");
}

describe("output budget with superseded instruction snapshots", () => {
  it("keeps the configured output budget when a restored long session continues", async () => {
    const { baseUrl, requests } = await gateway();
    const createdAt = "2026-10-20T10:00:00.000Z";
    const history: UiMessage[] = [];
    let previous: string | undefined;
    for (let index = 0; index < UPDATES; index++) {
      const update = { role: "system", content: "", sections: { context: section(index) }, timestamp: 1_000 + index };
      history.push({
        id: `update-${index}`, role: "system", content: "", createdAt,
        modelSystem: {
          version: 1, messageJson: JSON.stringify(update),
          ...(previous ? { afterMessageId: previous } : {}),
        },
      });
      history.push({ id: `user-${index}`, role: "user", content: `Step ${index}`, createdAt, status: "complete" });
      history.push({
        id: `assistant-${index}`, role: "assistant", content: `Done ${index}.`, createdAt, status: "complete",
        // The provider measured the folded request, not the unfolded history.
        usage: { inputTokens: 12_000, outputTokens: 100, totalTokens: 12_100 },
      });
      previous = `assistant-${index}`;
    }
    const runtime = new DesktopAgentRuntime({
      sessionId: "long-session", mode: "agent", provider: gatewayProvider(baseUrl), history, thinkingLevel: "omit",
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
      host: {
        call: async <T>(method: string): Promise<T> => {
          if (method === "tools.fileBatchCapabilities") return { version: 1, supported: false } as T;
          if (method === "session.appendMessage") return undefined as T;
          throw new Error(`Unexpected host method: ${method}`);
        },
        onNotification: () => () => {},
      },
      onEvent: () => {},
    });
    cleanups.push(async () => { await runtime.dispose(); });

    await runtime.prompt("Continue");

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request.max_output_tokens).toBe(OUTPUT);
    expect(instructionItems(request)).toHaveLength(1);
    expect(JSON.stringify(request.input)).not.toContain("update-0:");
  });

  it("keeps a delegate's output budget when instruction updates follow its usage anchor", async () => {
    const { baseUrl, requests } = await gateway();
    const binding = subagentModelBinding(
      { provider: gatewayProvider(baseUrl), thinkingLevel: "off", sessionId: "long-session" },
      { claim: () => undefined },
    );
    const messages: Message[] = [
      { role: "system", content: "Delegate instructions.", timestamp: 1 },
      { role: "user", content: "Review the change.", timestamp: 2 },
      {
        role: "assistant", content: [{ type: "text", text: "Reviewing." }],
        api: "openai-responses", provider: binding.model.provider, model: binding.model.id,
        usage: {
          input: 12_000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 12_100,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop", timestamp: 3,
      },
      ...Array.from({ length: UPDATES }, (_, index): Message => ({
        role: "system", content: "", sections: { context: section(index) }, timestamp: 4 + index,
      })),
      { role: "user", content: "Continue.", timestamp: 100 },
    ];

    const result = await binding.streamFn(binding.model, normalizeContext({ messages }), {}).result();

    expect(result.stopReason).toBe("stop");
    expect(requests).toHaveLength(1);
    expect(requests[0].max_output_tokens).toBe(OUTPUT);
    expect(instructionItems(requests[0])).toHaveLength(1);
  });
});
