/** Logical tool policy. Only Host can prove that file resources are independent. */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import specs from "@pi-desktop/shared/tool-execution-spec.json" with { type: "json" };

type ToolExecutionSpec = { file: boolean; parallel: boolean; requiresFileBatch: boolean };
export const TOOL_EXECUTION_SPECS: Readonly<Record<string, ToolExecutionSpec | undefined>> = specs;

export function toolExecutionMode(name: string, hostFileBatches = false): "parallel" | "sequential" {
  const spec = TOOL_EXECUTION_SPECS[name];
  return spec?.parallel && (!spec.requiresFileBatch || hostFileBatches) ? "parallel" : "sequential";
}

export function resolveBatchExecutionMode(message: AssistantMessage): "parallel" | "sequential" | undefined {
  const names = message.content.filter((b) => b.type === "toolCall").map((b) => b.name);
  return names.includes("Task") && names.some((name) => TOOL_EXECUTION_SPECS[name]?.file)
    ? "sequential" : undefined;
}

export function resolveTaskExecutionMode(lastMessage: unknown): "parallel" | "sequential" {
  if (typeof lastMessage === "object" && lastMessage !== null
    && (lastMessage as { role?: unknown }).role === "assistant"
    && Array.isArray((lastMessage as { content?: unknown }).content)
    && resolveBatchExecutionMode(lastMessage as AssistantMessage) === "sequential") return "sequential";
  return "parallel";
}

export function withDynamicTaskExecutionMode<T extends { name: string; executionMode?: "parallel" | "sequential" }>(
  tool: T, getLastMessage: () => unknown,
): T {
  if (tool.name !== "Task" || tool.executionMode !== "parallel") return tool;
  return Object.defineProperty(tool, "executionMode", {
    enumerable: true, configurable: true, get: () => resolveTaskExecutionMode(getLastMessage()),
  });
}
