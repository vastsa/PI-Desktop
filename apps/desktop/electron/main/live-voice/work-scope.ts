import { sessionWorkspaceIdentity } from "@pi-desktop/host-runtime";

type WorkSessionSummary = {
  id?: unknown;
  source?: unknown;
  projectId?: unknown;
  title?: unknown;
  projectPath?: unknown;
  providerId?: unknown;
  modelId?: unknown;
  mode?: unknown;
  thinkingLevel?: unknown;
  permissionMode?: unknown;
};

type HostRpc = {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
};

export async function requireSupportedWorkSession(input: {
  host: HostRpc;
  bindings: ReadonlyMap<string, { workSessionId: string; workspaceIdentity?: string | null }>;
  sessionId: string;
  callId?: string;
}): Promise<WorkSessionSummary> {
  const isBound = () => input.callId !== undefined
    ? input.bindings.get(input.callId)?.workSessionId === input.sessionId
    : [...input.bindings.values()].some((binding) => binding.workSessionId === input.sessionId);
  const unavailable = () => Object.assign(new Error("The Live work session is no longer available"), {
    errorCode: "LIVE_WORK_SESSION_UNAVAILABLE",
  });

  if (!isBound()) throw unavailable();
  const listed = await input.host.call<{ sessions?: WorkSessionSummary[] }>("session.list");
  if (!isBound()) throw unavailable();
  const session = listed.sessions?.find((item) => item.id === input.sessionId);
  if (!session) throw unavailable();
  if (session.source !== undefined && session.source !== "desktop") {
    throw Object.assign(new Error("Live work integration supports only local Desktop sessions"), {
      errorCode: "LIVE_WORK_BACKEND_UNSUPPORTED",
    });
  }
  if (input.callId !== undefined) {
    const binding = input.bindings.get(input.callId);
    if (binding && Object.hasOwn(binding, "workspaceIdentity") && sessionWorkspaceIdentity(session) !== binding.workspaceIdentity) {
      throw Object.assign(new Error("The Live work session workspace changed after authorization"), {
        errorCode: "LIVE_WORK_SCOPE_CHANGED",
      });
    }
  }
  return session;
}
