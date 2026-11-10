import type { UiMessage } from "./types/messages.js";

type SubagentControlBase = { sessionId: string; operationId: string };
/** Only declarative, session-scoped commands cross preload; launch credentials
 * and permissions are resolved by Electron Main from authoritative state. */
export type AgentSubagentControlRequest = SubagentControlBase & (
  | { action: "start"; agent: string; task: string; model?: string }
  | { action: "message"; delegationId: string; content: string; model?: string }
);
export type AgentSubagentControlResponse = {
  accepted: true;
  operationId: string;
  delegationId: string;
  messageId: string;
  delivery: "started" | "queued" | "recorded";
};
/** Additive transcript metadata. User commands remain child-owned user rows,
 * never forged provider Task calls or implicit parent context. */
export type SubagentControlMetadata = {
  operationId: string;
  requestHash: string;
  action: "start" | "message";
  delegationId: string;
  agent: string;
  status?: "running" | "completed" | "failed" | "denied" | "stopped" | "aborted" | "timed_out";
  /** The parent turn ended while this child kept working (never a Stop). */
  detached?: boolean;
  modelId?: string;
  modelKey?: string;
  thinkingLevel?: string;
  resume?: string;
  description?: string;
};

export function parseSubagentControlRequest(value: unknown): AgentSubagentControlRequest {
  const fail = (): never => { throw Object.assign(new Error("Invalid subagent control request"), { errorCode: "INVALID_REQUEST" }); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  const text = (key: string, max: number): string => {
    const field = row[key];
    if (typeof field !== "string" || !field.trim() || field.length > max || field.includes("\0")) return fail();
    return field.trim();
  };
  const sessionId = text("sessionId", 200);
  const operationId = text("operationId", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(operationId)) return fail();
  const action = row.action;
  const keys = action === "start" ? ["sessionId", "operationId", "action", "agent", "task", "model"]
    : action === "message" ? ["sessionId", "operationId", "action", "delegationId", "content", "model"] : [];
  if (keys.length === 0 || Object.keys(row).some((key) => !keys.includes(key))) return fail();
  if (action === "start") return {
    sessionId, operationId, action, agent: text("agent", 200), task: text("task", 100_000),
    ...(row.model === undefined ? {} : { model: text("model", 500) }),
  };
  return {
    sessionId, operationId, action: "message", delegationId: text("delegationId", 200), content: text("content", 100_000),
    ...(row.model === undefined ? {} : { model: text("model", 500) }),
  };
}

/** Presentation adapter for existing delegation directories and chain readers.
 * Never persist or feed this synthetic tool shape to the provider. */
export function subagentTaskDisplayMessage(message: UiMessage): UiMessage {
  const control = message.subagentControl;
  if (message.role !== "user" || control?.action !== "start" || !message.parentToolCallId) return message;
  const { parentToolCallId, ...rest } = message;
  return {
    ...rest, role: "tool", toolName: "Task", toolCallId: parentToolCallId,
    status: control.status === "running" ? "streaming" : "complete",
    toolArgs: { agent: control.agent, task: message.content,
      ...(control.resume ? { resume: control.resume } : {}),
      ...(control.description ? { description: control.description } : {}) },
    toolResult: { details: {
      delegationId: control.delegationId, agent: control.agent,
      status: control.status ?? "aborted", modelId: control.modelId,
      modelKey: control.modelKey, thinkingLevel: control.thinkingLevel,
      ...(control.detached ? { detached: true } : {}),
      ownerCallId: parentToolCallId,
    } },
  };
}
