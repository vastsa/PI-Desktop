import { describe, expect, it } from "vitest";
import { approveRoleModelChange } from "./delegation-model-approval.js";

const input = {
  role: { name: "fixer", description: "Fix", tools: ["Read"], prompt: "Fix", source: "user" as const, modeOwner: "team", model: {providerId: "service", modelId: "primary"} },
  model: "service/other", sessionId: "session", toolCallId: "call",
};

describe("private role model authorization", () => {
  it("requires a new confirmation for this exact role, model and call", async () => {
    const ids = new Set<string>();
    for (const approved of [true, false, false]) {
      const result = await approveRoleModelChange({ ...input, ask: async request => {
        ids.add(request.requestId);
        expect(request).toMatchObject({ sessionId: "session", toolCallId: "call" });
        expect(request.questions[0].question).toContain("fixer with service/other instead of its configured service/primary");
        return approved ? [["Allow this delegation"]] : ids.size === 2 ? [["Keep configured model"]] : [null];
      } });
      expect(result).toBe(approved);
    }
    expect(ids.size).toBe(3);
  });
});
