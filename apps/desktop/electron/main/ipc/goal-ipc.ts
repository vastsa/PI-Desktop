import { IPC, type AgentPromptRequest, type GoalBudget, type GoalControlRequest } from "@pi-desktop/shared";
import type { AgentHostBridge } from "../agent-host-bridge";
import type { IpcRegistrar } from "./types";

export function registerGoalIpc(registrar: IpcRegistrar, getBridge: () => AgentHostBridge | null): void {
  const bridge = () => {
    const value = getBridge();
    if (!value) throw new Error("Goal host unavailable");
    return value.goals;
  };
  registrar.handle(IPC.invoke.goalsGet, async (request: { sessionId: string }) => bridge().get(request.sessionId));
  registrar.handle(IPC.invoke.goalsStart, async (request: AgentPromptRequest & { budget?: GoalBudget }) => bridge().start(request));
  registrar.handle(IPC.invoke.goalsControl, async (request: GoalControlRequest) => bridge().control(request));
}
