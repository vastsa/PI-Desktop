import type { UiMessage } from "@pi-desktop/shared";
import {
  delegationChainMaps,
  messageThinking,
  type SubagentRunItem,
} from "./assistant-turns";
import { isDelegationStartTool } from "./tool-display";
import { delegationIdForMessage } from "./subagent-panel";

/** One user/assistant exchange of a delegate session. */
export type SubagentTranscriptTurn = { task: string; rows: SubagentRunItem[] };

/**
 * A delegate's conversation as alternating turns: each Task call of the
 * delegation chain opens a turn with its `task` argument, followed by the
 * rows the delegate produced under that call.
 */
export type SubagentTranscript = {
  agentName?: string;
  turns: SubagentTranscriptTurn[];
};

function delegateTaskDescription(call: UiMessage): string {
  const args = call.toolArgs;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const task = (args as { task?: unknown }).task;
  return typeof task === "string" ? task.trim() : "";
}

function requestedAgentName(call: UiMessage): string {
  const args = call.toolArgs;
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  const agent = (args as { agent?: unknown }).agent;
  return typeof agent === "string" ? agent : "";
}

/** Task calls whose `resume` argument resolves to one of `priorCallIds`. */
function resumedCalls(
  messages: readonly UiMessage[],
  priorCallIds: ReadonlySet<string>,
  callByDelegationId: ReadonlyMap<string, string>,
): Set<string> {
  const next = new Set<string>();
  for (const message of messages) {
    if (message.role !== "tool" || !isDelegationStartTool(message.toolName)) {
      continue;
    }
    const args = message.toolArgs;
    const resume =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as { resume?: unknown }).resume
        : undefined;
    if (typeof resume !== "string" || !resume.trim()) continue;
    // The runtime records `resume` as a prior delegation id; a bare call id
    // is accepted too, so the chain stays legible before any result lands.
    const target = callByDelegationId.get(resume.trim()) ?? resume.trim();
    if (priorCallIds.has(target) && message.toolCallId) next.add(message.toolCallId);
  }
  return next;
}

/**
 * Build the delegate's transcript from the session messages.
 *
 * A Task call belongs to the delegation of `delegationId` when the call
 * identifies itself by that id — via its result payload, or via its own call
 * id when the runtime recorded none — or when it resumed another call of that
 * chain. Turns appear in session order; each turn's rows are the messages
 * whose `parentToolCallId` names that call, mapped exactly like the
 * delegation card's run grouping. Returns null when no Task call matches, so
 * the tab can show its unavailable state instead of an empty conversation.
 */
export function buildSubagentTranscript(
  messages: readonly UiMessage[],
  delegationId: string,
): SubagentTranscript | null {
  const target = delegationId.trim();
  const { childOf, callByDelegationId } = delegationChainMaps(messages);
  // A resumed call may cite the prior delegation id (the runtime's shape) or
  // a bare prior call id. `childOf` covers the delegation-id form; the bare
  // form is resolved here so the chain still closes before results land.
  const resumeLink = new Map(childOf);
  for (const message of messages) {
    if (message.role !== "tool" || !isDelegationStartTool(message.toolName)) {
      continue;
    }
    const args = message.toolArgs;
    const resume =
      args && typeof args === "object" && !Array.isArray(args)
        ? (args as { resume?: unknown }).resume
        : undefined;
    if (typeof resume !== "string" || !resume.trim()) continue;
    const priorId = callByDelegationId.get(resume.trim()) ?? resume.trim();
    if (message.toolCallId && !resumeLink.has(priorId)) {
      resumeLink.set(priorId, message.toolCallId);
    }
  }
  const calls = messages.filter(
    (message) =>
      message.role === "tool" &&
      isDelegationStartTool(message.toolName) &&
      Boolean(message.toolCallId),
  );
  // The chain is the connected component of resumed calls around the call
  // this delegation id names; forward and backward walks share that set.
  let chain = new Set(
    calls
      .filter((call) => delegationIdForMessage(call) === target)
      .map((call) => call.toolCallId as string),
  );
  if (chain.size === 0) return null;
  for (;;) {
    const forward = resumedCalls(messages, chain, callByDelegationId);
    const backward = new Set(
      [...chain].flatMap((callId) => {
        const prior = [...resumeLink.entries()]
          .filter(([, next]) => next === callId)
          .map(([priorId]) => priorId);
        return prior;
      }),
    );
    const grown = new Set([
      ...chain,
      ...[...forward, ...backward].filter((id) => !chain.has(id)),
    ]);
    if (grown.size === chain.size) break;
    chain = grown;
  }

  // Attribution prefers what the delegate's own rows carried; a chain whose
  // delegate has not produced a row yet falls back to the requested agent.
  const runAgentName = messages.find(
    (message) =>
      message.parentToolCallId &&
      chain.has(message.parentToolCallId) &&
      message.agentName,
  )?.agentName;
  const requestedName = calls
    .filter((call) => chain.has(call.toolCallId as string))
    .map(requestedAgentName)
    .find(Boolean);
  const agentName = runAgentName || requestedName;

  const turns: SubagentTranscriptTurn[] = [];
  for (const call of calls) {
    const callId = call.toolCallId as string;
    if (!chain.has(callId)) continue;
    const rows: SubagentRunItem[] = [];
    for (const message of messages) {
      if (message.parentToolCallId !== callId) continue;
      if (message.role === "tool") {
        rows.push({ kind: "tool", message });
        continue;
      }
      // A delegate turn can carry reasoning and text at once, and both are
      // worth showing: the text is the only place its narration and report
      // exist.
      if (messageThinking(message)) rows.push({ kind: "thinking", message });
      if ((message.content || "").trim() || message.error) {
        rows.push({ kind: "answer", message });
      }
    }
    turns.push({ task: delegateTaskDescription(call), rows });
  }

  return {
    ...(agentName ? { agentName } : {}),
    turns,
  };
}
