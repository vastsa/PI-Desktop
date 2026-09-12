/** The renderer-local subagent detail currently shown in the work-panel dock. */
export type SubagentPanelSelection = {
  sessionId: string;
  /** Stable delegation id from the Task result, used to re-find live rows. */
  delegationId: string;
};
