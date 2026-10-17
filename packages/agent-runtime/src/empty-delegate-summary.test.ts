import { expect, it } from "vitest";
import type {
  Api,
  AssistantMessage,
  Model,
  Models,
} from "@earendil-works/pi-ai";
import { prepareDelegateTurnContext } from "./subagent-context.js";
import { buildProviderModel } from "./provider-binding.js";

/**
 * A thinking-only, output-limited summary reply must not install an empty
 * compacted checkpoint. textFromContent ignores thinking blocks, so the
 * extracted summary is ""; accepting it as success would drop recent tool
 * evidence while reporting kind "compacted".
 */
async function reproduce(
  responseKind: "thinking-only" | "provider-error" | "valid-text",
) {
  const model: Model<Api> = {
    ...buildProviderModel({
      id: "fixture",
      name: "Fixture",
      modelId: "fixture",
      apiKey: "",
      authKind: "none",
      supportsReasoning: true,
      supportedThinkingLevels: ["off", "low"],
      baseUrl: "http://127.0.0.1:1/v1",
    }),
    contextWindow: 8192,
    maxTokens: 1024,
  };
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const assistant = (
    content: AssistantMessage["content"],
  ): AssistantMessage => ({
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "stop",
    timestamp: 2,
  });
  const taskBrief =
    "Inspect permissions and keep the result of the latest Read.";
  let summaryRequests = 0;
  const outcome = await prepareDelegateTurnContext({
    model,
    taskBrief,
    retentionMode: "active_turn",
    signal: new AbortController().signal,
    messages: [
      { role: "user", content: taskBrief, timestamp: 1 },
      {
        ...assistant([
          {
            type: "toolCall",
            id: "old-read",
            name: "Read",
            arguments: { path: "old-file.ts" },
          },
        ]),
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "old-read",
        toolName: "Read",
        isError: false,
        content: [{ type: "text", text: "old history ".repeat(1500) }],
        timestamp: 2,
      },
      {
        ...assistant([
          {
            type: "toolCall",
            id: "read-1",
            name: "Read",
            arguments: { path: "permissions.ts" },
          },
        ]),
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "Read",
        isError: false,
        content: [
          {
            type: "text",
            text: "RECENT_FINDING: permission check is missing.",
          },
        ],
        timestamp: 3,
      },
    ],
    // Mock only the external summary completion. No network or paid API is used.
    summaryModels: () =>
      ({
        completeSimple: async () => {
          summaryRequests++;
          if (responseKind === "provider-error") {
            return {
              ...assistant([]),
              stopReason: "error",
              errorMessage: "401 invalid API key",
            };
          }
          if (responseKind === "valid-text") {
            return assistant([
              {
                type: "text",
                text: "The permission check is missing; inspect permissions.ts next.",
              },
            ]);
          }
          return {
            ...assistant([
              { type: "thinking", thinking: "I need to summarize this." },
            ]),
            stopReason: "length",
          };
        },
      }) as unknown as Models,
  });
  expect(summaryRequests).toBeGreaterThan(0);
  return outcome;
}

it("does not replace real delegate history with an empty successful checkpoint", async () => {
  const outcome = await reproduce("thinking-only");
  // A thinking-only completion has no summary text; it must enter the existing
  // failed-summary degradation path, which preserves the brief and recent evidence.
  expect(outcome.kind).toBe("degraded");
  if (outcome.kind === "degraded") {
    expect(JSON.stringify(outcome.messages)).toContain("RECENT_FINDING");
  }
});

it("control: a reported provider error preserves recent evidence through degradation", async () => {
  const outcome = await reproduce("provider-error");
  expect(outcome.kind).toBe("degraded");
  if (outcome.kind === "degraded") {
    expect(JSON.stringify(outcome.messages)).toContain("RECENT_FINDING");
  }
});

it("control: a real text summary produces a compacted context", async () => {
  const outcome = await reproduce("valid-text");
  expect(outcome.kind).toBe("compacted");
  if (outcome.kind === "compacted") {
    expect(JSON.stringify(outcome.messages)).toContain(
      "permission check is missing",
    );
  }
});
