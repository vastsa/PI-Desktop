import {
  MAX_PLUGIN_SUBAGENT_IDS,
  MAX_PLUGIN_SUBAGENT_TASK_CHARS,
  PLUGIN_SUBAGENT_WAIT_MAX_MS,
} from "@pi-desktop/shared";
import type { StartSubagentForToolInput, WaitSubagentsInput } from "./runtime.js";

/**
 * Shape checks for the plugin-started delegation RPCs (`agent.startSubagent`,
 * `agent.waitSubagents`; issue #2508). Electron main already validated the
 * plugin's input and owns the ids; this is the sidecar's own boundary check,
 * so a malformed frame is refused with a stable code instead of reaching the
 * runtime.
 */
function invalid(message: string): Error {
  return Object.assign(new Error(message), {
    rpcCode: -32602,
    errorCode: "INVALID_ARGUMENT",
  });
}

function requiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value.trim()) throw invalid(`${key} must be a non-empty string`);
  return value;
}

function optionalString(
  params: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw invalid(`${key} must be a string`);
  return value;
}

export function parseStartSubagentParams(
  params: Record<string, unknown>,
): { sessionId: string; input: StartSubagentForToolInput } {
  const sessionId = requiredString(params, "sessionId");
  const task = requiredString(params, "task");
  if (task.length > MAX_PLUGIN_SUBAGENT_TASK_CHARS) {
    throw invalid(`task exceeds ${MAX_PLUGIN_SUBAGENT_TASK_CHARS} characters`);
  }
  const description = optionalString(params, "description");
  const model = optionalString(params, "model");
  return {
    sessionId,
    input: {
      turnId: requiredString(params, "turnId"),
      toolCallId: requiredString(params, "toolCallId"),
      agent: requiredString(params, "agent"),
      task,
      ...(description !== undefined ? { description } : {}),
      ...(model !== undefined ? { model } : {}),
    },
  };
}

export function parseWaitSubagentsParams(
  params: Record<string, unknown>,
): { sessionId: string; input: WaitSubagentsInput } {
  const sessionId = requiredString(params, "sessionId");
  const ids = params.delegationIds;
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > MAX_PLUGIN_SUBAGENT_IDS ||
    ids.some((id) => typeof id !== "string" || !id.trim())
  ) {
    throw invalid(`delegationIds must list 1..${MAX_PLUGIN_SUBAGENT_IDS} delegation ids`);
  }
  const mode = params.mode;
  if (mode !== undefined && mode !== "all" && mode !== "any") {
    throw invalid('mode must be "all" or "any"');
  }
  const timeoutMs = params.timeoutMs;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 0 ||
    timeoutMs > PLUGIN_SUBAGENT_WAIT_MAX_MS
  ) {
    throw invalid(`timeoutMs must be 0..${PLUGIN_SUBAGENT_WAIT_MAX_MS}`);
  }
  const toolCallId = optionalString(params, "toolCallId");
  return {
    sessionId,
    input: {
      delegationIds: ids as string[],
      ...(mode ? { mode } : {}),
      timeoutMs,
      ...(toolCallId ? { toolCallId } : {}),
    },
  };
}
