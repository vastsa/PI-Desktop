import { buildSubagentReplyIndex, inheritSubagentRecordedModel, normalizeSubagentName,
  subagentRecordedModel, subagentTaskDisplayMessage, subagentTaskPayload,
  type SessionSummary, type UiMessage } from "@pi-desktop/shared";
import { delegateAgentName } from "../chat/transcript/model";
import { delegationChainMaps } from "../../lib/assistant-turns";
import { delegationIdForMessage } from "../../lib/subagent-panel";
import { collectDelegationStatuses, delegationIsCreating, subagentOutcome, type SubagentOutcome } from "../../lib/subagent-topology";
import { isDelegationStartTool } from "../../lib/tool-display";

export type SubagentFilter = "all" | "running" | "completed" | "failed";
export type SessionSubagent = {
  key: string;
  delegationId: string;
  agentName: string;
  description: string;
  task: string;
  modelId: string;
  modelKey: string;
  /** Only an issued handle can authorize continuation; rejected calls have none. */
  continuationId?: string;
  status: SubagentOutcome;
  creating: boolean;
  calls: UiMessage[];
};

/** Later snapshots win; stable timestamp ordering keeps resume prompts in order. */
export function mergeSubagentMessages(
  older: readonly UiMessage[],
  newer: readonly UiMessage[],
): UiMessage[] {
  const byId = new Map(older.map((message) => [message.id, message]));
  for (const message of newer) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function argument(message: UiMessage, name: string): string {
  const args = message.toolArgs;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const value = (args as Record<string, unknown>)[name];
  return typeof value === "string" ? value.trim() : "";
}

/** The index and transcript share the same Task resume links and status rules. */
export function buildSessionSubagents(
  messages: readonly UiMessage[],
  turnLive: boolean,
): SessionSubagent[] {
  const display = messages.map(subagentTaskDisplayMessage);
  const replies = buildSubagentReplyIndex(messages);
  const calls = display.filter((message) => message.role === "tool" &&
    !message.parentToolCallId && message.toolCallId && isDelegationStartTool(message.toolName));
  const { childOf } = delegationChainMaps(calls);
  const parentOf = new Map([...childOf].map(([parent, child]) => [child, parent]));
  const groups = new Map<string, UiMessage[]>();
  const roots = new Map<string, string>();
  for (const call of calls) {
    const callId = call.toolCallId ?? call.id;
    let root = callId;
    const seen = new Set<string>();
    while (parentOf.has(root) && !seen.has(root)) {
      if (roots.has(root)) { root = roots.get(root) ?? root; break; }
      seen.add(root);
      root = parentOf.get(root) ?? root;
    }
    roots.set(callId, root);
    const group = groups.get(root) ?? [];
    group.push(call);
    groups.set(root, group);
  }
  const items = display.filter((message) => message.role === "tool")
    .map((message) => ({ kind: "tool" as const, message }));
  const statuses = collectDelegationStatuses(items, { turnLive });
  const agents: SessionSubagent[] = [...groups].map(([key, chain]) => {
    const latest = chain[chain.length - 1];
    const agentName = delegateAgentName(latest);
    const model = chain.reduce((previous, call) => inheritSubagentRecordedModel(previous,
      subagentRecordedModel(call, replies, delegateAgentName(call))), { modelId: "", modelKey: "" });
    const handle = subagentTaskPayload(latest)?.delegationId;
    return {
      key,
      delegationId: delegationIdForMessage(latest),
      continuationId: typeof handle === "string" && handle.trim() ? handle.trim() : undefined,
      agentName,
      description: argument(latest, "description") || argument(latest, "task"),
      task: argument(latest, "task"),
      ...model,
      status: subagentOutcome(latest, statuses),
      creating: delegationIsCreating(latest),
      calls: chain,
    };
  }).reverse();
  const byHandle = new Map<string, SessionSubagent>();
  for (const agent of agents) {
    if (!agent.continuationId) continue;
    for (const call of agent.calls) {
      byHandle.set(delegationIdForMessage(call), agent);
      byHandle.set(call.toolCallId ?? call.id, agent);
    }
  }
  return agents.map((agent) => {
    if (agent.continuationId || agent.creating) return agent;
    const latest = agent.calls[agent.calls.length - 1];
    const target = byHandle.get(argument(latest, "resume"));
    if (!target || normalizeSubagentName(target.agentName) !== normalizeSubagentName(agent.agentName)) return agent;
    // The rejection is still its own visible attempt, never a new child. Its
    // controls point to the real chain and preserve that child's model.
    return { ...agent, continuationId: target.continuationId, modelId: target.modelId, modelKey: target.modelKey };
  });
}

/** Resolve a selected error card to its actual child without creating authority. */
export function continuationSubagent(
  agents: readonly SessionSubagent[], selected: SessionSubagent | undefined,
): SessionSubagent | undefined {
  return selected?.continuationId ? agents.find((agent) => agent.delegationId === selected.continuationId) : undefined;
}

export function filterSessionSubagents(
  agents: readonly SessionSubagent[],
  query: string,
  filter: SubagentFilter,
): SessionSubagent[] {
  const search = query.trim().toLocaleLowerCase();
  return agents.filter((agent) => {
    const statusMatches = filter === "all" || (filter === "failed"
      ? agent.status !== "running" && agent.status !== "completed"
      : agent.status === filter);
    return statusMatches && (!search ||
      [agent.agentName, agent.description, agent.task, agent.modelId, agent.delegationId]
        .some((value) => value.toLocaleLowerCase().includes(search)));
  });
}

/** UI affordance only; Main and the runtime independently enforce authority. */
export function canControlSubagents(session: SessionSummary | undefined): boolean {
  return session?.mode === "agent" && session.source !== "remote" && session.source !== "pi-native" &&
    !session.id.startsWith("remote:") && !session.id.startsWith("native-pi:") &&
    session.capabilities?.canPrompt !== false && session.capabilities?.canUseLocalTools !== false;
}
