import { randomUUID } from "node:crypto";
import type { AskToolRequest, SubagentDefinition } from "@pi-desktop/shared";

const approve = "Allow this delegation";

/** Approval belongs only to this outstanding Task. An opt-in binding says
 * that a model may run delegates, not that a dispatcher may replace a pin. */
export async function approveRoleModelChange(input: {
  role: SubagentDefinition;
  model: string;
  sessionId: string;
  toolCallId: string;
  ask: (request: AskToolRequest) => Promise<Array<string[] | null>>;
}): Promise<boolean> {
  const { role, model, sessionId, toolCallId, ask } = input;
  if (!role.model || !role.modeOwner) return true;
  const answers = await ask({
    sessionId, toolCallId, requestId: randomUUID(),
    questions: [{ question: `Run ${role.name} with ${model} instead of its configured ${role.model.providerId}/${role.model.modelId} for this delegation?`, options: ["Keep configured model", approve] }],
  });
  return answers.length === 1 && answers[0]?.length === 1 && answers[0][0] === approve;
}
