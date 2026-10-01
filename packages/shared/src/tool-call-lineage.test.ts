import { describe, expect, it } from "vitest";
import { toolCallLineage } from "./tool-call-lineage.js";

describe("terminal tool lineage", () => {
  it("retains recovered start attribution and fills independent terminal nesting", () => {
    expect(toolCallLineage(
      { parentToolCallId: "delegate", agentName: "worker", nestedParentToolCallId: undefined },
      { parentToolCallId: "later-owner", agentName: "later-name", nestedParentToolCallId: "compose" },
    )).toEqual({ parentToolCallId: "delegate", agentName: "worker", nestedParentToolCallId: "compose" });
  });
  it("uses terminal attribution when a restored start has none", () => {
    expect(toolCallLineage({}, { parentToolCallId: "delegate", agentName: "worker" }))
      .toEqual({ parentToolCallId: "delegate", agentName: "worker" });
  });
});
