import { describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentEventEnvelope, UiMessage } from "@pi-desktop/shared";
import { DesktopAgentRuntime } from "./runtime.js";

const PARTIAL = "The answer ends in the middle of";

function reply(stopReason: AssistantMessage["stopReason"], withTool = false): AssistantMessage {
  return {
    role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture",
    stopReason, timestamp: 1,
    content: [
      { type: "text", text: PARTIAL },
      ...(withTool ? [{ type: "toolCall" as const, id: "truncated-call", name: "plugin_demo_probe", arguments: {} }] : []),
    ],
    usage: { input: 10, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 210,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function fixture(first: AssistantMessage) {
  const events: AgentEventEnvelope["event"][] = [];
  const host = { call: vi.fn(async (_method: string) => ({})) };
  const runtime = new DesktopAgentRuntime({
    host: host as never, sessionId: "output-truncation", mode: "agent", thinkingLevel: "off",
    provider: { id: "fixture", name: "Fixture", modelId: "fixture", apiKey: "fixture",
      baseUrl: "http://localhost/v1", supportsReasoning: false, supportedThinkingLevels: ["off"] },
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    pluginTools: [{ name: "plugin_demo_probe", description: "Probe", parameters: {} }],
    onEvent: ({ event }) => events.push(event),
  });
  const stream = vi.spyOn(runtime["models"], "streamSimple").mockImplementation(() => {
    const message = stream.mock.calls.length === 1 ? first : reply("stop");
    const result = createAssistantMessageEventStream();
    queueMicrotask(() => {
      result.push({ type: "start", partial: message });
      if (message.stopReason === "aborted") result.push({ type: "error", reason: "aborted", error: message });
      else result.push({ type: "done", reason: message.stopReason as "length" | "stop", message });
      result.end(message);
    });
    return result;
  });
  const messages = () => events.flatMap((event): UiMessage[] =>
    event.type === "message_end" && event.message.role === "assistant" ? [event.message] : []);
  return { runtime, host, stream, events, messages };
}

describe("main-chat output truncation", () => {
  it("marks a length-limited answer without changing its text or retrying, and accepts a follow-up", async () => {
    const f = fixture(reply("length"));
    try {
      await f.runtime.prompt("Write a long answer.");
      expect(f.messages()).toHaveLength(1);
      expect(f.messages()[0]).toMatchObject({ content: PARTIAL, status: "complete", outputTruncated: true });
      expect(f.stream).toHaveBeenCalledTimes(1);
      expect(f.events.some((event) => event.type === "error")).toBe(false);
      expect(f.runtime.getStatus().isRunning).toBe(false);
      await f.runtime.prompt("Continue.");
      expect(f.stream).toHaveBeenCalledTimes(2);
      expect(f.messages()[1].outputTruncated).not.toBe(true);
    } finally { await f.runtime.dispose(); }
  });

  it.each(["stop", "aborted"] as const)("does not mark a %s response as output-limited", async (reason) => {
    const f = fixture(reply(reason));
    try {
      await f.runtime.prompt("Reply.");
      expect(f.messages()).toHaveLength(1);
      expect(f.messages()[0].outputTruncated).not.toBe(true);
      expect(f.stream).toHaveBeenCalledTimes(1);
    } finally { await f.runtime.dispose(); }
  });

  it("keeps Pi's truncated-tool rejection and recovery without adding an answer warning", async () => {
    const f = fixture(reply("length", true));
    try {
      await f.runtime.prompt("Run the probe.");
      expect(f.stream).toHaveBeenCalledTimes(2);
      expect(f.host.call.mock.calls.some(([method]) => method === "tools.execute")).toBe(false);
      expect(f.events).toContainEqual(expect.objectContaining({ type: "tool_end", isError: true }));
      expect(f.messages().some((message) => message.outputTruncated)).toBe(false);
    } finally { await f.runtime.dispose(); }
  });
});
