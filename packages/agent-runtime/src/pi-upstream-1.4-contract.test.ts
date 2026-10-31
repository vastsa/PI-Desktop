import type { Agent } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
import { describe, expect, it } from "vitest";
import { DesktopAgentRuntime } from "./runtime.js";

type Request = {
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
};

function toolReply(id: string, args: string): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {
    tool_calls: [{ index: 0, id, type: "function", function: { name: "Write", arguments: args } }],
  }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function finalReply(): Response {
  return new Response('data: {"choices":[{"index":0,"delta":{"content":"Saved."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', {
    headers: { "content-type": "text/event-stream" },
  });
}

function fixture() {
  const executions: unknown[] = [];
  const requests: Request[] = [];
  const runtime = new DesktopAgentRuntime({
    sessionId: "pi-1.4-fixture", mode: "agent", thinkingLevel: "off",
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    provider: {
      id: "fixture", name: "Fixture", modelId: "fixture", apiKey: "fixture",
      baseUrl: "http://localhost/v1", supportsReasoning: false, supportedThinkingLevels: ["off"],
    },
    host: {
      call: async <T>(method: string, params?: unknown): Promise<T> => {
        if (method === "tools.execute") {
          executions.push(params);
          return { ok: true, content: { path: "saved.txt", bytes: 6 } } as T;
        }
        return undefined as T;
      },
    },
    onEvent: () => {},
  });
  const agent = (runtime as unknown as { agent: Agent }).agent;
  const respond = (reply: (round: number) => Response) => {
    agent.streamFunction = (model, context) => stream(model as Model<"openai-completions">, context, {
      apiKey: "fixture", maxRetries: 0,
      fetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        if (requests.length > 3) throw new Error("Unexpected extra model request");
        return reply(requests.length);
      },
    });
  };
  return { runtime, executions, requests, respond, agent };
}

describe("Pi 1.4 tool-call contracts through Desktop", () => {
  it("rejects malformed final JSON before Host execution and accepts a corrected call", async () => {
    const { runtime, executions, requests, respond, agent } = fixture();
    const malformed = '{"path":"wrong.txt","content":"partial",';
    respond((round) => round === 1 ? toolReply("bad-call", malformed)
      : round === 2 ? toolReply("good-call", '{"path":"saved.txt","content":"ready"}')
      : finalReply());
    try {
      await runtime.prompt("Save the file.", "user", "turn");
      expect(executions).toEqual([expect.objectContaining({
        toolName: "Write", args: { path: "saved.txt", content: "ready" },
      })]);
      const rejected = requests[1]?.messages.find((message) => message.role === "tool" && message.tool_call_id === "bad-call");
      expect(rejected?.content).toContain(malformed);
      expect(agent.state.messages.at(-1)).toMatchObject({
        role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Saved." }],
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps all fields when a tool string contains a literal invalid Unicode escape", async () => {
    const { runtime, executions, respond } = fixture();
    respond((round) => round === 1
      ? toolReply("latex-call", String.raw`{"content":"\usepackage{amsmath}","path":"saved.txt"}`)
      : finalReply());
    try {
      await runtime.prompt("Save the LaTeX file.", "user", "turn");
      expect(executions).toEqual([expect.objectContaining({
        toolName: "Write", args: { path: "saved.txt", content: String.raw`\usepackage{amsmath}` },
      })]);
    } finally {
      await runtime.dispose();
    }
  });
});
