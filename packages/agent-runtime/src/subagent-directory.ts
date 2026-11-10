/** Read-only session directory. Inspection never widens the resumable cache. */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { formatResumableList, listedReadFiles, type DelegationChain, type ResumableChain } from "./delegation-history.js";
import { parseSubagentContentParams } from "./subagent-content.js";
import { SUBAGENT_LIST_TOOL_NAME } from "./subagent.js";

export function buildSubagentDirectoryTool(options: {
  snapshot: () => {
    delegations: Record<string, unknown>[];
    heartbeats: string[];
    resumable: ResumableChain[];
    recorded: DelegationChain[];
  };
}): AgentTool {
  return {
    name: SUBAGENT_LIST_TOOL_NAME,
    label: "Task List",
    description: "List this session's subagents, including user-created and historical conversations. Live status and resumable ids are separate from the paged recorded directory. Use TaskRead to inspect a recorded id; listing it does not grant Task resume permission. offset/limit page recorded history only.",
    parameters: Type.Object({
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "Recorded-history offset; defaults to 0." })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Recorded chains per page; defaults to 40, maximum 100." })),
    }),
    executionMode: "sequential",
    execute: async (_callId, params) => {
      const parsed = parseSubagentContentParams(params);
      if (!parsed.ok) {
        return { isError: true, content: [{ type: "text", text: parsed.message }],
          details: { error: { code: "SUBAGENT_LIST_INVALID_ARGUMENT", message: parsed.message } } };
      }
      const { delegations, heartbeats, resumable, recorded } = options.snapshot();
      const entries = recorded.slice(parsed.offset, parsed.offset + parsed.limit).map(chain => ({
        agent: chain.agentName,
        delegationId: chain.latestDelegationId ?? chain.delegateSessionId,
        ...(chain.delegationIds.length > 1 ? { previousDelegationId: chain.delegationIds.at(-2) } : {}),
        status: chain.latestStatus ?? "unknown",
        objective: (chain.latestObjective ?? "").slice(0, 512),
      }));
      const hasMore = parsed.offset + entries.length < recorded.length;
      const page = { total: recorded.length, offset: parsed.offset, returned: entries.length,
        hasMore, nextOffset: hasMore ? parsed.offset + entries.length : null, entries };
      const text = [
        heartbeats.length ? heartbeats.map(line => `- ${line}`).join("\n")
          : recorded.length ? "No live subagent records; recorded history is listed below."
            : "No subagents have been started in this session.",
        formatResumableList(resumable),
        `Recorded subagent conversations (TaskRead only; not a resume grant):\n${JSON.stringify(page)}`,
      ].filter(part => part.trim()).join("\n\n");
      return { content: [{ type: "text", text }], details: {
        delegations,
        resumable: resumable.map(chain => ({ agent: chain.agentName, delegationId: chain.latestDelegationId,
          objective: chain.latestObjective, ...listedReadFiles(chain.readFiles) })),
        recorded: page,
      } };
    },
  };
}
