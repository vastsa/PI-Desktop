import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { includeCurrentTurnMessages, receiveCurrentTurnMessages, type ReceivedSessionMessage } from "./current-turn-messages.js";

const message: ReceivedSessionMessage = {
  id: "session-message:m08", role: "user", content: "Worker08 report", createdAt: "2026-09-23T00:00:00Z",
  sessionMessage: { messageId: "m08", sourceSessionId: "worker08", sourceTitle: "worker08", targetSessionId: "parent", kind: "message" },
};
describe("current-turn session reception", () => {
  it("retries a lost acknowledgement with the same receipt key, never using steering", async () => {
    const call = vi.fn().mockRejectedValueOnce(new Error("reply lost"))
      .mockResolvedValue({ messages: [message] });
    const result = await receiveCurrentTurnMessages({ host: { call }, sessionId: "parent", turnId: "turn", isCurrent: () => true });
    expect(result).toEqual([message]);
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0]).toEqual(call.mock.calls[1]);
    expect(call.mock.calls[0][0]).toBe("session.collaboration.receive");
    expect(call.mock.calls[0][1]).toMatchObject({ sessionId: "parent", turnId: "turn" });
  });
  it("does not receive before an actual live-turn boundary", async () => {
    const call = vi.fn();
    await expect(receiveCurrentTurnMessages({ host: { call }, sessionId: "parent", turnId: "turn", isCurrent: () => false })).rejects.toMatchObject({ name: "AbortError" });
    expect(call).not.toHaveBeenCalled();
  });
  it("Stop during acceptance prevents a model request and never releases an uncertain receipt", async () => {
    const controller = new AbortController();
    const call = vi.fn().mockImplementation(async () => {
      controller.abort();
      return { messages: [message] };
    });
    await expect(receiveCurrentTurnMessages({ host: { call }, sessionId: "parent", turnId: "turn", isCurrent: () => true, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("does not inject an old reply after a turn epoch change", async () => {
    let current = true;
    const call = vi.fn().mockImplementation(async () => { current = false; return { messages: [message] }; });
    await expect(receiveCurrentTurnMessages({ host: { call }, sessionId: "parent", turnId: "old", isCurrent: () => current })).rejects.toMatchObject({ name: "AbortError" });
  });
  it("bounds retries without turning unknown acceptance into next-turn delivery", async () => {
    const call = vi.fn().mockRejectedValue(new Error("transport unavailable"));
    await expect(receiveCurrentTurnMessages({ host: { call }, sessionId: "parent", turnId: "turn", isCurrent: () => true })).rejects.toThrow("transport unavailable");
    expect(call).toHaveBeenCalledTimes(3);
    expect(new Set(call.mock.calls.map((c) => c[1].requestId)).size).toBe(1);
  });
  it.each([
    { ...message, steering: true },
    { ...message, id: "forged" },
    { ...message, sessionMessage: { ...message.sessionMessage, targetSessionId: "other" } },
    { ...message, sessionMessage: { ...message.sessionMessage, kind: "task" } },
  ])("rejects non-canonical input rather than presenting it as human input", async (invalid) => {
    const call = vi.fn().mockResolvedValue({ messages: [invalid] });
    await expect(receiveCurrentTurnMessages({ host: { call }, sessionId: "parent", turnId: "turn", isCurrent: () => true })).rejects.toThrow("provenance");
  });
  it("retains fresh messages once after context shaping without changing tool results", () => {
    const first: AgentMessage = { role: "user", content: "framed-message-08", timestamp: 1 };
    const second: AgentMessage = { role: "user", content: "framed-message-09", timestamp: 2 };
    const tool: AgentMessage = { role: "toolResult", toolCallId: "wait09", toolName: "Wait", content: [{ type: "text", text: "worker09 completed" }], isError: false, timestamp: 3 };
    const context = includeCurrentTurnMessages([tool, first, { ...first }], [first, second]);
    expect(context).toEqual([tool, first, second]);
    expect(context[0]).toBe(tool);
  });
});
