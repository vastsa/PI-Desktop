import { describe, expect, it } from "vitest";
import { parseSubagentControlRequest, subagentTaskDisplayMessage } from "./subagent-control.js";

describe("direct subagent control contract", () => {
  const start = { sessionId: "session", operationId: "op-1", action: "start", agent: "explorer", task: "Inspect src/app.ts", model: "fixture/model" };
  const message = { sessionId: "session", operationId: "op-2", action: "message", delegationId: "delegate", content: "Only inspect tests" };
  it("accepts a bounded start and a direct message without transport configuration", () => {
    expect(parseSubagentControlRequest(start)).toEqual(start);
    expect(parseSubagentControlRequest(message)).toEqual(message);
  });
  it("accepts a trimmed optional model with a user's next child message", () => {
    expect(parseSubagentControlRequest({ ...message, model: "  account/model  " })).toEqual({ ...message, model: "account/model" });
  });
  it.each([start, message])("accepts a model key at the same 500-character bound", (request) => {
    expect(parseSubagentControlRequest({ ...request, model: "x".repeat(500) }).model).toHaveLength(500);
  });
  it.each([start, message].flatMap(request => [
    { ...request, model: "x".repeat(501) }, { ...request, model: " " }, { ...request, model: "account/\0model" },
    { ...request, model: "account/model", apiKey: "fixture-only" },
    { ...request, model: "account/model", provider: { id: "account" } },
    { ...request, model: "account/model", credentials: { token: "fixture-only" } },
    { ...request, model: "account/model", permissions: "auto" },
  ]))("rejects invalid model keys and keeps the privilege whitelist strict", (request) => {
    expect(() => parseSubagentControlRequest(request)).toThrow();
  });
  it.each([
    { ...start, task: " " }, { ...start, operationId: "../escape" },
    { ...start, sessionId: "" }, { ...start, provider: { apiKey: "unexpected" } },
    { ...start, action: "message" }, { ...start, task: "x".repeat(100_001) },
  ])("rejects malformed or privilege-bearing input", (request) => {
    expect(() => parseSubagentControlRequest(request)).toThrow();
  });
  it("projects a user start only for display, keeping the durable row a child-owned user message", () => {
    const row = { id: "user-subagent-op-1", role: "user" as const, content: "Inspect the code", createdAt: "2026-11-03T00:00:00Z", parentToolCallId: "user-subagent-op-1", agentName: "explorer", subagentControl: { operationId: "op-1", requestHash: "fingerprint", action: "start" as const, delegationId: "delegate", agent: "explorer", status: "running" as const, modelId: "model" } };
    const display = subagentTaskDisplayMessage(row);
    expect(row.role).toBe("user");
    expect(row.parentToolCallId).toBe("user-subagent-op-1");
    expect(display.role).toBe("tool");
    expect(display.parentToolCallId).toBeUndefined();
    expect(display.toolArgs).toEqual({ agent: "explorer", task: "Inspect the code" });
    expect(display.toolResult).toMatchObject({ details: { delegationId: "delegate", status: "running" } });
  });
});
