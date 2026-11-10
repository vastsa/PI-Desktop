import {
  ErrorCodes, IPC, parseSubagentControlRequest,
  type AgentSubagentControlResponse, type AppSettings, type SessionSummary,
} from "@pi-desktop/shared";
import type { AgentIpcDependencies } from "./agent-ipc";

type Launch = {
  providerId: string; modelId: string; projectPath?: string;
  workspaceRoot?: string; sidecarParams: Record<string, unknown>;
};
type ControlSession = Record<string, unknown> & Pick<SessionSummary, "id" | "mode"> &
  Partial<Pick<SessionSummary, "source" | "capabilities">>;
export type SubagentControlIpcDependencies = Pick<AgentIpcDependencies,
  "registrar" | "getHost" | "getSidecar" | "activeTurns" | "recordTurnStart" |
  "isTurnDispatchable" | "acquireSessionOperation" | "finishTurn"> & {
  resolveAgentRuntimeLaunch: (sessionId: string, session: Record<string, unknown>, settings: AppSettings) => Promise<Launch>;
};
const rejection = (message: string, errorCode: string = ErrorCodes.INVALID_ARGUMENT) =>
  Object.assign(new Error(message), { errorCode });

function requireControlSession(session: ControlSession | undefined, sessionId: string): ControlSession {
  if (!session || session.id !== sessionId) throw rejection("Session not found", ErrorCodes.NOT_FOUND);
  if (session.source === "remote" || session.source === "pi-native") {
    throw rejection("Direct subagent control requires a local desktop session");
  }
  if (session.mode !== "agent") throw rejection("Direct subagent control requires Agent mode");
  if (session.capabilities?.canPrompt === false || session.capabilities?.canUseLocalTools === false) {
    throw rejection("Direct subagent control is unavailable for this session");
  }
  return session;
}

/** Declarative user control, sharing the authoritative launch and turn owner.
 * No caller-provided mode, provider, tool catalog or permission ceiling. */
export function registerSubagentControlIpc(deps: SubagentControlIpcDependencies): void {
  deps.registrar.handle(IPC.invoke.agentSubagentControl, async (input: unknown) => {
    const request = parseSubagentControlRequest(input);
    if (request.sessionId.startsWith("native-pi:") || request.sessionId.startsWith("remote:")) {
      throw rejection("Direct subagent control requires a local desktop session");
    }
    const release = await deps.acquireSessionOperation(request.sessionId);
    let createdTurnId: string | undefined;
    try {
      const host = deps.getHost();
      const sidecar = deps.getSidecar();
      if (!host || !sidecar) throw rejection("Backend unavailable", ErrorCodes.HOST_UNAVAILABLE);
      const assertBackend = () => {
        if (deps.getHost() !== host || deps.getSidecar() !== sidecar) {
          throw rejection("Session backend changed while preparing the command", ErrorCodes.AGENT_BUSY);
        }
      };
      const readSession = async (bounded: boolean) => {
        const detail = await host.call<{ session?: ControlSession }>("session.get", {
          id: request.sessionId, ...(bounded ? { messageLimit: 1, contentLimit: 512 } : {}),
        });
        assertBackend();
        return requireControlSession(detail.session, request.sessionId);
      };
      await readSession(true);
      let turnId = deps.activeTurns.get(request.sessionId);
      if (turnId) {
        if (!deps.isTurnDispatchable(request.sessionId, turnId)) {
          throw rejection("The target turn has ended", ErrorCodes.TURN_NOT_FOUND);
        }
        return await sidecar.call<AgentSubagentControlResponse>("agent.controlSubagent", {
          sessionId: request.sessionId, turnId, existingTurn: true, request,
        });
      }
      const settings = await host.call<AppSettings>("settings.get");
      const session = await readSession(false);
      const launch = await deps.resolveAgentRuntimeLaunch(request.sessionId, session, settings);
      await readSession(true);
      if (deps.activeTurns.has(request.sessionId)) {
        throw rejection("A session turn started while preparing the command", ErrorCodes.AGENT_BUSY);
      }
      sidecar.setProjectInstructionRoot(request.sessionId, launch.workspaceRoot ?? launch.projectPath);
      const turn = await host.call<{ turnId?: string }>("session.beginTurn", {
        sessionId: request.sessionId, providerId: launch.providerId, modelId: launch.modelId,
      });
      turnId = turn.turnId?.trim();
      if (!turnId) throw rejection("session.beginTurn returned no turn");
      createdTurnId = turnId;
      deps.activeTurns.set(request.sessionId, turnId);
      deps.recordTurnStart(request.sessionId, turnId);
      assertBackend();
      if (!deps.isTurnDispatchable(request.sessionId, turnId)) {
        throw rejection("The prepared turn was cancelled", ErrorCodes.TURN_NOT_FOUND);
      }
      const response = await sidecar.call<AgentSubagentControlResponse>("agent.controlSubagent", {
        ...launch.sidecarParams, sessionId: request.sessionId, turnId, request,
      });
      if (response.delivery === "recorded") {
        await deps.finishTurn(request.sessionId, "completed", undefined, { turnId, createNotification: false });
      }
      return response;
    } catch (error) {
      if (createdTurnId) {
        const code = error && typeof error === "object" && "errorCode" in error &&
          typeof error.errorCode === "string" ? error.errorCode : undefined;
        await deps.finishTurn(request.sessionId, "error", code, { turnId: createdTurnId, createNotification: false });
      }
      throw error;
    } finally {
      release();
    }
  });
}
