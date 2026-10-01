import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Mode } from "@pi-desktop/shared";

/** Known editing/delegation names stay declared across contract-mode changes. */
const RETAINED_MODE_TOOLS = new Set(["Write", "Edit", "Task", "TaskWait", "TaskList", "TaskStop"]);

export function retainModeToolDeclaration(name: string): boolean {
  return RETAINED_MODE_TOOLS.has(name);
}

export function modeToolDenial(name: string, mode: Mode): string {
  return `${name} is not allowed in ${mode} mode. No action was performed. Continue read-only inspection and planning with the permitted tools; implementation requires Agent mode or approval of the submitted plan or goal.`;
}

/**
 * Declarations are not grants. Recheck immediately before execution, including
 * references retained from an earlier mode. Throwing here uses pi's existing
 * tool-error channel and the real call id, without inventing transcript items.
 */
export function withModeExecutionGuard(tool: AgentTool, denial: () => string | undefined): AgentTool {
  const currentDenial = denial();
  return {
    ...tool,
    description: currentDenial ? `${tool.description}\n\n${currentDenial}` : tool.description,
    execute: async (...args) => {
      const reason = denial();
      if (reason) throw new Error(reason);
      return tool.execute(...args);
    },
  };
}
