import type { AgentPromptRequest, AgentPromptResponse, GoalBudget, SessionSummary } from "@pi-desktop/shared";
import i18n from "i18next";
import { isRemoteSession } from "../../lib/remote-session-safety";

interface UserPromptApi {
  prompt(request: AgentPromptRequest): Promise<AgentPromptResponse>;
  startGoal(request: AgentPromptRequest & { budget?: GoalBudget }): Promise<AgentPromptResponse>;
}
/** Called only by explicit idle Composer submission, never by internal prompt callers. */
export function submitUserPrompt(api: UserPromptApi, session: SessionSummary | undefined, request: AgentPromptRequest) {
  if (session?.mode !== "goal") return api.prompt(request);
  if (isRemoteSession(session) || session.source === "pi-native") {
    throw new Error(i18n.t("autonomousGoal.localOnly"));
  }
  // Omit the whole budget so the host snapshots its persisted defaults.
  return api.startGoal(request);
}
