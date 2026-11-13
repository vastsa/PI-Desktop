import { describe, expect, it } from "vitest";
import type { UiMessage } from "./types/messages.js";
import { buildSubagentReplyIndex, inheritSubagentRecordedModel, isSubagentTaskTool,
  subagentRecordedModel, subagentTaskPayload } from "./subagent-history.js";

const task = (details: Record<string, unknown>, args: Record<string, unknown> = {}): UiMessage => ({
  id: "task", role: "tool", content: "", createdAt: "2026-11-03T00:00:00.000Z",
  toolName: "Task", toolCallId: "call", toolArgs: { agent: "explorer", task: "Original brief", ...args },
  toolResult: { details },
});
const reply = (extra: Partial<UiMessage> = {}): UiMessage => ({
  id: "reply", role: "assistant", content: "Recorded finding", createdAt: "2026-11-03T00:00:01.000Z",
  parentToolCallId: "call", agentName: "explorer", modelId: "retained", providerId: "original", ...extra,
});

describe("subagent history projection", () => {
  it("accepts legacy Task spellings and payloads without treating lifecycle tools as starts", () => {
    for (const name of ["Task", "functions.Task", "functions.Subagent"]) expect(isSubagentTaskTool(name)).toBe(true);
    for (const name of ["TaskWait", "TaskList", "TaskStop", "TaskRead", "OtherTask", undefined]) expect(isSubagentTaskTool(name)).toBe(false);
    const details = { delegationId: "recorded", status: "completed" };
    expect(subagentTaskPayload(task(details))).toEqual(details);
    expect(subagentTaskPayload({ ...task(details), toolResult: details })).toEqual(details);
    expect(subagentTaskPayload({ ...task(details), toolResult: [] })).toBeUndefined();
  });

  it("indexes only the call's own normalized agent replies and keeps the latest model evidence", () => {
    const rows = [reply({ id: "old", providerId: "old", modelId: "old" }), reply({ agentName: "Explorer.md" }),
      reply({ id: "foreign", agentName: "fixer", providerId: "foreign" }),
      reply({ id: "sibling", parentToolCallId: "other", providerId: "sibling" }),
      reply({ id: "parent", parentToolCallId: undefined, providerId: "parent" })];
    const before = JSON.stringify(rows);
    expect(subagentRecordedModel(task({}), buildSubagentReplyIndex(rows), "explorer"))
      .toEqual({ modelId: "retained", modelKey: "original/retained" });
    expect(JSON.stringify(rows)).toBe(before);
  });

  it.each([undefined, "custom/retained"])("resolves an echoed legacy alias from the account that answered: %s", modelKey => {
    const row = task({ modelId: "retained", modelKey }, { model: "custom/retained" });
    expect(subagentRecordedModel(row, buildSubagentReplyIndex([reply()]), "explorer"))
      .toEqual({ modelId: "retained", modelKey: "original/retained" });
  });

  it("preserves an explicit account switch even when the model id did not change", () => {
    const row = task({ modelId: "retained", modelKey: "new/retained" });
    expect(subagentRecordedModel(row, buildSubagentReplyIndex([reply()]), "explorer"))
      .toEqual({ modelId: "retained", modelKey: "new/retained" });
  });

  it("never binds a recorded new model to an old reply account", () => {
    const row = task({ modelId: "new-model" });
    expect(subagentRecordedModel(row, buildSubagentReplyIndex([reply()]), "explorer"))
      .toEqual({ modelId: "new-model", modelKey: "" });
  });

  it("inherits missing continuation metadata but clears a stale account for a different model", () => {
    const previous = { modelId: "retained", modelKey: "original/retained" };
    expect(inheritSubagentRecordedModel(previous, { modelId: "", modelKey: "" })).toEqual(previous);
    expect(inheritSubagentRecordedModel(previous, { modelId: "retained", modelKey: "" })).toEqual(previous);
    expect(inheritSubagentRecordedModel(previous, { modelId: "new", modelKey: "" }))
      .toEqual({ modelId: "new", modelKey: "" });
  });

  it.each([
    { modelKey: "recorded/retained", modelId: "retained" },
    { modelKey: "recorded/vendor/retained", modelId: "vendor/retained" },
  ])("retains a key-only recorded binding: $modelKey", ({ modelKey, modelId }) => {
    const row = task({ modelKey });
    const expected = { modelId, modelKey };
    expect(subagentRecordedModel(row, buildSubagentReplyIndex([]), "explorer")).toEqual(expected);
    expect(inheritSubagentRecordedModel({ modelId: "old", modelKey: "old/old" }, { modelId: "", modelKey }))
      .toEqual(expected);
  });

  it("does not replace a key-only model switch with an older reply", () => {
    const row = task({ modelKey: "new/new-model" });
    expect(subagentRecordedModel(row, buildSubagentReplyIndex([reply()]), "explorer"))
      .toEqual({ modelId: "new-model", modelKey: "new/new-model" });
  });
});
