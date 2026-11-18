import { ErrorCodes, IPC, type SessionDetail, type SideQuestionList } from "@pi-desktop/shared";
import type { SessionIpcDependencies } from "./session-ipc";

/** Desktop-only user actions; no model-facing parent/child delivery channel. */
export function registerSideQuestionIpc(deps: Pick<SessionIpcDependencies, "registrar" | "getHost" | "sessionCapabilityContext" | "enrichSession" | "persistenceOutbox">): void {
  const operations = [
    [IPC.invoke.sideQuestionCreate, "session.sideQuestion.create"],
    [IPC.invoke.sideQuestionList, "session.sideQuestion.list"],
    [IPC.invoke.sideQuestionArchive, "session.sideQuestion.archive"],
  ] as const;
  for (const [channel, method] of operations) {
    deps.registrar.handle(channel, async (input: Record<string, unknown> = {}) => {
      const id = input.parentSessionId ?? input.id;
      if (typeof id !== "string" || !id.trim() || id.length > 256 || id.startsWith("remote:") || id.startsWith("native-pi:")) {
        throw Object.assign(new Error("A local session id is required"), { errorCode: ErrorCodes.INVALID_ARGUMENT });
      }
      const host = deps.getHost();
      if (!host) throw new Error("Host unavailable");
      if (channel === IPC.invoke.sideQuestionCreate) await deps.persistenceOutbox.flush(deps.getHost);
      const { providers, defaults } = await deps.sessionCapabilityContext();
      if (deps.getHost() !== host) throw new Error("Host changed before side question operation");
      const result = await host.call<SideQuestionList & { session?: SessionDetail; ok?: boolean }>(method, input);
      if (deps.getHost() !== host) throw new Error("Host changed during side question operation");
      return {
        ...result,
        ...(result.session ? { session: deps.enrichSession(result.session, providers, defaults) } : {}),
        ...(result.sessions ? { sessions: result.sessions.map(session => deps.enrichSession(session, providers, defaults)) } : {}),
      };
    });
  }
}
