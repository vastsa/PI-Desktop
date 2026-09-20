import { afterEach, expect, it, vi } from "vitest";
import type { AgentEventEnvelope } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";
import type { RuntimeProviderConfig } from "./provider-binding.js";
import { SubagentRun } from "./subagent.js";

const provider: RuntimeProviderConfig = {
  id: "certificate-fixture", name: "Certificate fixture",
  baseUrl: "https://provider.invalid/v1", modelId: "fixture-model",
  apiKey: "fixture-key", authKind: "api_key", apiStyle: "chat_completions",
  supportsReasoning: false, supportedThinkingLevels: ["off"],
};

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each(["session", "delegate"])(
  "%s stops certificate failures before setup or stream replay and preserves the cause",
  async (kind) => {
    const events: AgentEventEnvelope[] = [];
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("self signed certificate in certificate chain"), {
          code: "SELF_SIGNED_CERT_IN_CHAIN",
        }),
      });
    });
    vi.stubGlobal("fetch", fetch);
    const onEvent = (event: AgentEventEnvelope) => events.push(event);
    const runtime = kind === "session" ? new DesktopAgentRuntime({
      sessionId: "certificate-session", mode: "agent", provider,
      thinkingLevel: "off", onEvent,
      host: { call: async () => { throw new Error("Unexpected host request"); } },
      commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    }) : undefined;
    try {
      const done = runtime ? runtime.prompt("Hello", "user-1", "turn-1") : new SubagentRun({
        sessionId: "certificate-session", turnId: "turn-1", parentToolCallId: "task-1",
        definition: { name: "explorer", description: "Fixture", prompt: "Reply", tools: [], source: "builtin" },
        task: "Hello", systemPrompt: "Reply", tools: [], provider, thinkingLevel: "off", onEvent,
      }).run();
      await done;
      expect(fetch).toHaveBeenCalledTimes(1);
      const errors = events.flatMap(({ event }) =>
        event.type === "message_end" && event.message.error ? [event.message.error] : [],
      );
      expect(errors).toContainEqual(expect.objectContaining({
        code: "NETWORK_ERROR", retriable: false,
        details: expect.objectContaining({ networkCode: "SELF_SIGNED_CERT_IN_CHAIN" }),
      }));
    } finally { await runtime?.dispose(); }
  },
);
