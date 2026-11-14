import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentEventEnvelope, ModeCompletionReport, ModeTurnContext } from "@pi-desktop/shared";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";
import { builtinModeDefinition } from "./mode-definitions.js";

const provider: RuntimeProviderConfig = {
  id: "local", name: "Local", baseUrl: "http://127.0.0.1:1/v1", modelId: "fixture", apiKey: "", authKind: "none",
  supportsReasoning: false, supportedThinkingLevels: ["off"],
  modelConfig: { source: "generic", name: "Local", baseUrl: "http://127.0.0.1:1/v1", reasoning: false,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128_000, maxTokens: 8192 },
};
const modeTurn: ModeTurnContext = {
  runId: "run-1", stageId: "work", origin: "host", enteredStage: false,
  input: "Build the authorized artifact", artifactPaths: { goal: ".pi/goals/run-1.md" },
};
const blocked: ModeCompletionReport = {
  status: "blocked", outcomes: [{ criterion: "Build", outcome: "unverified", evidence: "Approval is missing" }],
  remainingWork: ["Build after approval"], blockerReason: "The user must approve the build",
};

/** Only the external model stream and Host RPC are scripted; Agent and tool wiring are real. */
function fixture(answer: unknown, report?: ModeCompletionReport) {
  const events: AgentEventEnvelope[] = [];
  const call = vi.fn(async (method: string) => {
    if (method === "modes.completeStage") {
      if (answer instanceof Error) throw answer;
      return answer;
    }
    return {};
  });
  const runtime = new DesktopAgentRuntime({
    host: { call: async <T = unknown>(method: string): Promise<T> => await call(method) as T, onNotification: () => () => {} }, sessionId: "session-1", provider,
    mode: "goal", modeDefinition: builtinModeDefinition("goal"), thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    onEvent: (event) => events.push(event),
  });
  let requests = 0;
  (runtime as unknown as { models: unknown }).models = {
    streamSimple: () => {
      requests += 1;
      const stop = requests >= 3;
      const message: AssistantMessage = {
        role: "assistant", api: "openai-completions", provider: "local", model: "fixture",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: stop ? "stop" : "toolUse", timestamp: 2,
        content: stop ? [{ type: "text", text: "Unexpected retry" }] : [{ type: "toolCall", id: `call-${requests}`,
          name: "CompleteStage", arguments: { summary: "Build status", ...(report ? { report } : {}) } }],
      };
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: stop ? "stop" : "toolUse", message });
        stream.end(message);
      });
      return stream;
    },
  };
  return { runtime, events, call, requests: () => requests };
}

describe("mode completion through the public Agent prompt", () => {
  it.each<[string, ModeCompletionReport | undefined]>([
    ["finished", undefined],
    ["blocked", blocked],
  ])("ends a %s report without another model request", async (status, report) => {
    const test = fixture({ status, message: "Waiting for approval", run: { id: "run-1" } }, report);
    try {
      await test.runtime.prompt({ text: "continue", modeTurn }, undefined, "turn-1");
      expect(test.requests()).toBe(1);
      expect(test.call.mock.calls.filter(([method]) => method === "modes.completeStage")).toHaveLength(1);
      expect(test.events.some(({ event }) => event.type === "error")).toBe(false);
      expect(test.runtime.getStatus().isRunning).toBe(false);
    } finally { await test.runtime.dispose(); }
  });

  it.each([
    Object.assign(new Error("host method not allowed from sidecar: modes.completeStage"), { code: -32601 }),
    new Error("completion transport closed"),
    { status: "unknown", run: {} },
  ])("emits a real turn error for completion infrastructure failure %o", async (failure) => {
    const test = fixture(failure);
    try {
      await test.runtime.prompt({ text: "continue", modeTurn }, undefined, "turn-1");
      expect(test.requests()).toBe(1);
      const errors = test.events.filter(({ event }) => event.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.event).toMatchObject({ type: "error", error: { code: "MODE_COMPLETE_STAGE_FAILED" } });
      const errorIndex = test.events.findIndex(({ event }) => event.type === "error");
      const endIndex = test.events.findIndex(({ event }) => event.type === "agent_end");
      expect(errorIndex).toBeLessThan(endIndex);
      expect(test.runtime.getStatus().isRunning).toBe(false);
    } finally { await test.runtime.dispose(); }
  });
});
