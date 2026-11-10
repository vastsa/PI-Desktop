import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { SubagentRun } from "./subagent.js";
import type { SubagentMessageModel } from "./subagent-model-binding.js";

export const SUBAGENT_RECOVER_TOOL_NAME = "TaskRecover";
type RecoveryResult = { oldModelKey: string; newModelKey: string };
export function buildSubagentRecoveryTool(port: {
  target(id: string, signal?: AbortSignal): { run: SubagentRun; validate(): void; authorize(key: string): Promise<SubagentMessageModel> };
  ordered(operation: () => Promise<RecoveryResult>): Promise<RecoveryResult>;
  error(callId: string, message: string): AgentToolResult<unknown>;
}): AgentTool {
  const pending = new Set<string>();
  return {
    name: SUBAGENT_RECOVER_TOOL_NAME,
    label: "Task Recover",
    description: "Switch a live child started by this parent to another exact providerId/modelId after its active provider attempt emits zero events (including thinking) for 120 seconds. TaskList and TaskWait expose stalled attempts. Requires fresh authorization for a currently user-enabled subagent model. This interrupts only the stalled request, retains completed tool results, and continues the child; it does not change the parent model or stop the child. User-owned tasks, tool execution, settled tasks, and duplicate recovery are rejected.",
    parameters: Type.Object({
      delegationId: Type.String({ description: "The live parent-owned delegation returned by Task." }),
      model: Type.String({ description: "Exact user-enabled providerId/modelId key, different from the current binding." }),
    }),
    executionMode: "sequential",
    execute: async (callId, params, signal) => {
      const { delegationId, model } = params as { delegationId: string; model: string };
      if (pending.has(delegationId)) return port.error(callId, "A recovery is already pending for this subagent");
      pending.add(delegationId);
      try {
        const target = port.target(delegationId, signal);
        const result = await port.ordered(() => target.run.recoverProvider(model, () => target.authorize(model), target.validate));
        return {
          content: [{ type: "text", text: `Recovered ${delegationId}: ${result.oldModelKey} → ${result.newModelKey}. The child continues with its carried context.` }],
          details: { delegationId, status: "recovered", ...result },
        };
      } catch (error) {
        return port.error(callId, error instanceof Error ? error.message : "Subagent recovery failed");
      } finally { pending.delete(delegationId); }
    },
  };
}
