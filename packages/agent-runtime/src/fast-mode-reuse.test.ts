import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";

import {
  DesktopAgentRuntime,
  type RuntimeProviderConfig,
} from "./runtime.js";
import type { CommandShellOption } from "@pi-desktop/shared";

/**
 * The `/fast` switch is resolved per launch, but the sidecar reuses a session's
 * runtime instead of rebuilding it, so a toggle mid-session reaches the next
 * request only through `DesktopAgentRuntime.setFastMode` (sidecar reuse path,
 * ADR 0334). These tests pin that seam end to end: the reused runtime keeps
 * matching, and the following request carries the new tier.
 */

const commandShell: CommandShellOption = {
  id: "bash",
  label: "Bash",
  dialect: "posix",
  available: true,
  isDefault: true,
};

const relayProvider: RuntimeProviderConfig = {
  id: "relay",
  name: "Relay",
  baseUrl: "https://relay.example.com/v1",
  modelId: "gpt-test",
  apiKey: "sk-test",
  authKind: "none",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
  modelConfig: {
    source: "generic",
    api: "responses",
    name: "GPT Test",
    baseUrl: "https://relay.example.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
};

function createRuntime(fastMode: boolean) {
  return new DesktopAgentRuntime({
    host: {
      call: vi.fn(async () => ({})),
      onNotification: vi.fn(() => () => {}),
    } as never,
    sessionId: "session-1",
    mode: "agent",
    provider: relayProvider,
    thinkingLevel: "off",
    commandShell,
    fastMode,
    onEvent: vi.fn(),
  });
}

type CapturedRequest = Record<string, unknown>;

function capturingFetch(bodies: CapturedRequest[]): typeof globalThis.fetch {
  return async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)) as CapturedRequest);
    return new Response(JSON.stringify({ error: { message: "fixture" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  };
}

async function requestOnce(
  runtime: DesktopAgentRuntime,
  fetch: typeof globalThis.fetch,
): Promise<void> {
  const internals = runtime as unknown as { agent: Agent; model: Model<Api> };
  const stream = await internals.agent.streamFunction(
    internals.model,
    { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as never,
    { apiKey: "sk-test", fetch },
  );
  // The fixture fails the request; only the captured body is under test.
  await stream.result().catch(() => undefined);
}

describe("fast mode on a reused runtime", () => {
  it("applies a mid-session /fast switch to the next request", async () => {
    const bodies: CapturedRequest[] = [];
    const fetch = capturingFetch(bodies);
    const runtime = createRuntime(false);

    await requestOnce(runtime, fetch);
    expect(bodies).toHaveLength(1);
    expect(bodies[0].service_tier).toBeUndefined();

    runtime.setFastMode(true);
    await requestOnce(runtime, fetch);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].service_tier).toBe("priority");

    runtime.setFastMode(false);
    await requestOnce(runtime, fetch);
    expect(bodies).toHaveLength(3);
    expect(bodies[2].service_tier).toBeUndefined();
  });

  it("keeps the runtime reusable across the switch so the sidecar applies it in place", () => {
    const runtime = createRuntime(false);
    const match = {
      mode: "agent" as const,
      provider: relayProvider,
      thinkingLevel: "off" as const,
      commandShell,
    };
    expect(runtime.matches(match)).toBe(true);
    runtime.setFastMode(true);
    // A rebuilt runtime would start a new agent; the switch must not be part of
    // the identity, or the reuse path (and its setFastMode call) never runs.
    expect(runtime.matches(match)).toBe(true);
  });
});

describe("fast mode across a trusted extension model switch", () => {
  const extensionModel = {
    id: "ext-responses",
    name: "Extension Responses",
    api: "openai-responses",
    provider: "ext-provider",
    baseUrl: "https://extension.example.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  } as unknown as Model<Api>;

  function extensionAgent(seen: Array<string | undefined>) {
    return {
      key: "ext:agent",
      extensionId: "ext",
      extensionLabel: "Extension",
      id: "agent",
      name: "Extension Agent",
      providerId: "ext-provider",
      models: [extensionModel],
      stream: (model: Model<Api>, _context: unknown, options?: { serviceTier?: string }) => {
        seen.push(options?.serviceTier);
        // Only the options the runtime hands the extension are under test.
        const message = {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        } as AssistantMessage;
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => {
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
        });
        return stream;
      },
    };
  }

  async function requestExtension(runtime: DesktopAgentRuntime): Promise<void> {
    const internals = runtime as unknown as { agent: Agent; model: Model<Api> };
    const stream = await internals.agent.streamFunction(
      internals.model,
      { messages: [{ role: "user", content: "hi", timestamp: 1 }] } as never,
      {},
    );
    await stream.result();
  }

  it("drops the priority tier when an extension switches the session to its own Responses model", async () => {
    const seen: Array<string | undefined> = [];
    const agent = extensionAgent(seen);
    const runtime = createRuntime(true);
    const internals = runtime as unknown as {
      extensionRunner?: unknown;
      setExtensionModel(model: unknown): Promise<boolean>;
    };
    internals.extensionRunner = {
      hasHandlers: () => false,
      findAgentModel: () => agent,
    };
    try {
      // `/fast` was allowed for the launch model; the bridge's setModel then
      // moves an idle session to an extension model with no such opt-in.
      expect(await internals.setExtensionModel(extensionModel)).toBe(true);
      await requestExtension(runtime);
      expect(seen).toEqual([undefined]);

      // The next launch re-applies the switch from the stored binding; only an
      // explicit allowance there brings the tier back.
      runtime.setFastMode(true);
      await requestExtension(runtime);
      expect(seen).toEqual([undefined, "priority"]);
    } finally {
      internals.extensionRunner = undefined;
      await runtime.dispose();
    }
  });
});
