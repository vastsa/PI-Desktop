import { describe, expect, it, vi } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { CommandShellOption, ModeTurnContext } from "@pi-desktop/shared";
import { builtinModeDefinition } from "./mode-definitions.js";
import { MODE_CLOSEOUT_MAX_REQUESTS } from "./modes/mode-state.js";
import { DesktopAgentRuntime, type RuntimeProviderConfig } from "./runtime.js";

/**
 * A Goal run turn when the user pauses or removes the run while the turn
 * works (ADR mode-definitions): Pause lets the turn wrap up within a bounded
 * number of model requests, Remove lets it finish as an ordinary Agent turn.
 * The model is scripted at the provider stream; the Host at its RPC boundary.
 */

const provider: RuntimeProviderConfig = {
  id: "local",
  name: "Local",
  baseUrl: "http://127.0.0.1:11434/v1",
  modelId: "local-model",
  apiKey: "",
  authKind: "none",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
  modelConfig: {
    source: "generic",
    name: "Local",
    baseUrl: "http://127.0.0.1:11434/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  },
};

const commandShell: CommandShellOption = { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true };

const TURN: ModeTurnContext = {
  runId: "run-1",
  stageId: "work",
  origin: "host",
  enteredStage: false,
  input: "Make checkout work",
  artifactPaths: { goal: ".pi/goals/run-1.md" },
};

/** The scripted model stops calling the probe on this request. */
const LAST_REQUEST = 9;

type Request = { system: string; tools: string[] };

function goalRuntime(onRequest: (runtime: DesktopAgentRuntime, index: number) => void, requests: Request[]) {
  const runtime = new DesktopAgentRuntime({
    host: {
      call: vi.fn(async (method: string) =>
        method === "tools.execute"
          ? { ok: true, content: { content: [{ type: "text", text: "probe ok" }], details: {} } }
          : {},
      ),
      onNotification: vi.fn(() => () => {}),
    } as never,
    sessionId: "session-1",
    mode: "goal",
    modeDefinition: builtinModeDefinition("goal"),
    provider,
    thinkingLevel: "off",
    commandShell,
    pluginTools: [{ name: "plugin_demo_probe", description: "probe", parameters: {} }],
    onEvent: vi.fn(),
  });
  // Every answer but the last calls the probe again.
  (runtime as unknown as { models: unknown }).models = {
    streamSimple: () => {
      const index = requests.length;
      // What this request was built from: the system prompt and the declared tools.
      const internals = runtime as unknown as { agentSystemPromptContent(): string; declaredTools(): AgentTool[] };
      requests.push({ system: internals.agentSystemPromptContent(), tools: internals.declaredTools().map((tool) => tool.name) });
      onRequest(runtime, index);
      const last = index + 1 >= LAST_REQUEST;
      const message = {
        role: "assistant",
        api: "openai-completions",
        provider: "local",
        model: "local-model",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: last ? "stop" : "toolUse",
        timestamp: 2,
        content: last
          ? [{ type: "text", text: "done" }]
          : [{ type: "text", text: `round ${index + 1}` }, { type: "toolCall", id: `call-${index + 1}`, name: "plugin_demo_probe", arguments: {} }],
      } as unknown as AssistantMessage;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: last ? "stop" : "toolUse", message });
        stream.end(message);
      });
      return stream;
    },
  };
  return runtime;
}

describe("a Goal run turn told about a user control", () => {
  it("wraps up after Pause within the closeout request budget", async () => {
    const requests: Request[] = [];
    const notices: Array<{ applied: boolean }> = [];
    const runtime = goalRuntime((current, index) => {
      if (index === 0) notices.push(current.modeTurnNotice({ turnId: "turn-1", runId: "run-1", action: "closeout" }));
    }, requests);
    try {
      await runtime.prompt({ text: "continue", modeTurn: TURN }, undefined, "turn-1");
      expect(notices).toEqual([{ applied: true }]);
      // The request in flight when Pause arrived, then at most the closeout budget.
      expect(requests).toHaveLength(1 + MODE_CLOSEOUT_MAX_REQUESTS);
      expect(requests[0]!.system).not.toContain("# Run paused");
      for (const request of requests.slice(1)) expect(request.system).toContain("# Run paused");
      // The next turn of a resumed run starts without the notice.
      requests.length = 0;
      await runtime.prompt({ text: "continue", modeTurn: { ...TURN, origin: "approval" } }, undefined, "turn-2");
      expect(requests[0]!.system).not.toContain("# Run paused");
    } finally {
      await runtime.dispose();
    }
  });

  it("finishes as an ordinary Agent turn after Remove", async () => {
    const requests: Request[] = [];
    const runtime = goalRuntime((current, index) => {
      if (index === 0) current.modeTurnNotice({ turnId: "turn-1", runId: "run-1", action: "release", mode: "agent" });
    }, requests);
    try {
      await runtime.prompt({ text: "continue", modeTurn: TURN }, undefined, "turn-1");
      expect(requests[0]!.tools).toContain("CompleteStage");
      expect(requests[0]!.system).toContain("# Mode run");
      // Not cut short: the turn runs until the model ends it.
      expect(requests).toHaveLength(LAST_REQUEST);
      for (const request of requests.slice(1)) {
        expect(request.tools).not.toContain("CompleteStage");
        expect(request.system).not.toContain("# Mode run");
      }
      expect(runtime.getMode()).toBe("agent");
    } finally {
      await runtime.dispose();
    }
  });

  it("ignores a notice for another turn or run", async () => {
    const requests: Request[] = [];
    const notices: Array<{ applied: boolean }> = [];
    const runtime = goalRuntime((current, index) => {
      if (index !== 0) return;
      notices.push(current.modeTurnNotice({ turnId: "turn-other", runId: "run-1", action: "closeout" }));
      notices.push(current.modeTurnNotice({ turnId: "turn-1", runId: "run-other", action: "closeout" }));
      notices.push(current.modeTurnNotice({ turnId: "turn-1", runId: "run-other", action: "release", mode: "agent" }));
    }, requests);
    try {
      await runtime.prompt({ text: "continue", modeTurn: TURN }, undefined, "turn-1");
      expect(notices).toEqual([{ applied: false }, { applied: false }, { applied: false }]);
      expect(requests).toHaveLength(LAST_REQUEST);
      expect(runtime.getMode()).toBe("goal");
    } finally {
      await runtime.dispose();
    }
  });
});
