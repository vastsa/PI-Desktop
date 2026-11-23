import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeContext, type Message } from "@earendil-works/pi-ai";
import type { UiMessage } from "@pi-desktop/shared";
import { withCompactionRequestHeaders } from "./compaction-request.js";
import { DesktopAgentRuntime } from "./runtime.js";
import {
  buildProviderModel,
  createProviderModels,
  type RuntimeProviderConfig,
} from "./provider-binding.js";
import { subagentModelBinding } from "./subagent-model-binding.js";

/**
 * Pi 1.5.1 Anthropic message threads keep one continuation slot per session
 * id. Desktop's side requests share the conversation's session id for gateway
 * affinity, so they must neither continue nor replace that slot, and the
 * runtime must release it when the session's runtime is disposed.
 */

type ThreadField = { type: "create" } | { type: "continue"; previous_message_id: string };
type WireRequest = { thread?: ThreadField; messages: unknown[] };

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function anthropicGateway(): Promise<{ baseUrl: string; requests: WireRequest[] }> {
  const requests: WireRequest[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    requests.push(JSON.parse(raw) as WireRequest);
    const id = `msg_${requests.length}`;
    const events = [
      { type: "message_start", message: {
        id, type: "message", role: "assistant", model: "claude-fixture", content: [],
        usage: { input_tokens: 10, output_tokens: 0 },
      } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `Reply ${requests.length}.` } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture address missing");
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

/** An Anthropic-compatible gateway whose catalog entry opts into message threads. */
function anthropicProvider(baseUrl: string): RuntimeProviderConfig {
  return {
    id: "anthropic-row", name: "Anthropic", vendorKey: "anthropic", baseUrl,
    modelId: "claude-fixture", apiKey: "fixture-not-real", apiStyle: "anthropic_messages",
    supportsReasoning: false, supportedThinkingLevels: ["off"],
    modelConfig: {
      source: "generic", name: "Claude fixture", baseUrl, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000, maxTokens: 4_096,
      compat: { supportsMessageThreads: true },
    },
  };
}

function createRuntime(sessionId: string, provider: RuntimeProviderConfig, history: UiMessage[] = []) {
  return new DesktopAgentRuntime({
    sessionId, mode: "agent", provider, history, thinkingLevel: "omit",
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
}

const threadType = (request: WireRequest | undefined) => request?.thread?.type;

describe("Anthropic message threads with Desktop side requests", () => {
  it("continues the conversation thread across delegate and summary requests", async () => {
    const { baseUrl, requests } = await anthropicGateway();
    const provider = anthropicProvider(baseUrl);
    const runtime = createRuntime("thread-session", provider);
    cleanups.push(async () => { await runtime.dispose(); });

    await runtime.prompt("First question");
    expect(requests).toHaveLength(1);
    expect(threadType(requests[0])).toBe("create");

    // A delegate shares the parent's session id.
    const binding = subagentModelBinding(
      { provider, thinkingLevel: "off", sessionId: "thread-session" },
      { claim: () => undefined },
    );
    const delegateMessages: Message[] = [{ role: "user", content: "Delegate task.", timestamp: 1 }];
    const delegate = await binding.streamFn(
      binding.model, normalizeContext({ messages: delegateMessages }), {},
    ).result();
    expect(delegate.stopReason).toBe("stop");
    expect(requests).toHaveLength(2);
    expect(requests[1].thread).toBeUndefined();

    // So does a compaction summary, even when its caller keeps cache retention.
    const model = buildProviderModel(provider);
    const summaryModels = withCompactionRequestHeaders(
      createProviderModels(provider, model), provider, "thread-session",
    );
    const summaryMessages: Message[] = [{ role: "user", content: "Summarize.", timestamp: 2 }];
    const summary = await summaryModels.completeSimple(
      model, normalizeContext({ messages: summaryMessages }), {},
    );
    expect(summary.stopReason).toBe("stop");
    expect(requests).toHaveLength(3);
    expect(requests[2].thread).toBeUndefined();

    // The conversation still continues its own thread with only the new turn.
    await runtime.prompt("Second question");
    expect(requests).toHaveLength(4);
    expect(requests[3].thread).toEqual({ type: "continue", previous_message_id: "msg_1" });
    expect(requests[3].messages.length).toBeLessThan(requests[0].messages.length + 2);
  });

  it("releases the session's thread when the runtime is disposed", async () => {
    const { baseUrl, requests } = await anthropicGateway();
    const provider = anthropicProvider(baseUrl);
    const first = createRuntime("disposed-session", provider);
    await first.prompt("First question");
    expect(threadType(requests[0])).toBe("create");
    await first.prompt("Second question");
    expect(threadType(requests[1])).toBe("continue");
    await first.dispose();

    // A later runtime for the same session id (for example after a restart)
    // starts a new thread instead of continuing the released one.
    const createdAt = "2026-11-18T10:00:00.000Z";
    const history: UiMessage[] = [
      { id: "u1", role: "user", content: "First question", createdAt, status: "complete" },
      { id: "a1", role: "assistant", content: "Reply 1.", createdAt, status: "complete" },
      { id: "u2", role: "user", content: "Second question", createdAt, status: "complete" },
      { id: "a2", role: "assistant", content: "Reply 2.", createdAt, status: "complete" },
    ];
    const second = createRuntime("disposed-session", provider, history);
    cleanups.push(async () => { await second.dispose(); });
    await second.prompt("Third question");
    expect(requests).toHaveLength(3);
    expect(threadType(requests[2])).toBe("create");
  });
});
