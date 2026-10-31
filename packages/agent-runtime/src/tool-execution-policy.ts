/** Logical tool policy. Only Host can prove that file resources are independent. */
import type { AssistantMessage } from "@earendil-works/pi-ai";

export type ToolExecutionSpec = { mode: "parallel" | "sequential"; file?: true };
export const TOOL_EXECUTION_SPECS: Readonly<Record<string, ToolExecutionSpec>> = {
  Read: { mode: "parallel", file: true },
  Glob: { mode: "parallel", file: true },
  Grep: { mode: "parallel", file: true },
  Write: { mode: "parallel", file: true },
  Edit: { mode: "parallel", file: true },
  Task: { mode: "parallel" },
};

export function toolExecutionMode(name: string, hostFileBatches = false): "parallel" | "sequential" {
  if (!hostFileBatches && (name === "Write" || name === "Edit")) return "sequential";
  return TOOL_EXECUTION_SPECS[name]?.mode ?? "sequential";
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
