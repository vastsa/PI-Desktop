import { describe, expect, it } from "vitest";
import {
  MAX_PLUGIN_SUBAGENT_IDS,
  MAX_PLUGIN_SUBAGENT_TASK_CHARS,
  PLUGIN_SUBAGENT_WAIT_MAX_MS,
} from "@pi-desktop/shared";
import { parseStartSubagentParams, parseWaitSubagentsParams } from "./plugin-subagent-rpc.js";

const start = {
  sessionId: "s1",
  turnId: "t1",
  toolCallId: "call-1",
  agent: "explorer",
  task: "Find it.",
};

describe("agent.startSubagent params", () => {
  it("keeps the invocation identity and optional fields", () => {
    expect(parseStartSubagentParams({ ...start, description: "find", model: "p/m" })).toEqual({
      sessionId: "s1",
      input: {
        turnId: "t1",
        toolCallId: "call-1",
        agent: "explorer",
        task: "Find it.",
        description: "find",
        model: "p/m",
      },
    });
    // `resume` is not part of the plugin surface and never reaches the runtime.
    expect(parseStartSubagentParams({ ...start, resume: "d1" }).input).not.toHaveProperty("resume");
  });

  it.each([
    ["sessionId", { ...start, sessionId: "" }],
    ["turnId", { ...start, turnId: undefined }],
    ["toolCallId", { ...start, toolCallId: 4 }],
    ["agent", { ...start, agent: " " }],
    ["task", { ...start, task: "" }],
    ["task", { ...start, task: "x".repeat(MAX_PLUGIN_SUBAGENT_TASK_CHARS + 1) }],
    ["model", { ...start, model: 1 }],
  ])("refuses a malformed %s", (_field, params) => {
    expect(() => parseStartSubagentParams(params as Record<string, unknown>)).toThrow(
      expect.objectContaining({ errorCode: "INVALID_ARGUMENT" }),
    );
  });
});

describe("agent.waitSubagents params", () => {
  const wait = { sessionId: "s1", delegationIds: ["d1"], timeoutMs: 1_000 };

  it("accepts a bounded wait", () => {
    expect(parseWaitSubagentsParams({ ...wait, mode: "any", toolCallId: "call-1" })).toEqual({
      sessionId: "s1",
      input: { delegationIds: ["d1"], mode: "any", timeoutMs: 1_000, toolCallId: "call-1" },
    });
  });

  it.each([
    { ...wait, delegationIds: [] },
    { ...wait, delegationIds: Array.from({ length: MAX_PLUGIN_SUBAGENT_IDS + 1 }, (_, i) => `d${i}`) },
    { ...wait, delegationIds: [""] },
    { ...wait, mode: "first" },
    { ...wait, timeoutMs: PLUGIN_SUBAGENT_WAIT_MAX_MS + 1 },
    { ...wait, timeoutMs: -1 },
    { ...wait, timeoutMs: undefined },
  ])("refuses %o", (params) => {
    expect(() => parseWaitSubagentsParams(params as Record<string, unknown>)).toThrow(
      expect.objectContaining({ errorCode: "INVALID_ARGUMENT" }),
    );
  });
});
