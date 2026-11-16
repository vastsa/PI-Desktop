import type { ProjectGroupRecord, RemoteWorkspace } from "@pi-desktop/shared";

type FileHost = { call<T>(method: string, input?: unknown): Promise<T> };

export async function sessionForFiles(
  getHost: () => FileHost | null,
  sessionId: string,
  getSidecar?: () => FileHost | null,
): Promise<{ projectPath?: string; worktree?: unknown }> {
  const native = sessionId.startsWith("native-pi:");
  const getOwner = native ? getSidecar : getHost;
  const owner = getOwner?.();
  if (!owner) throw Object.assign(new Error("session source unavailable"), { errorCode: "HOST_UNAVAILABLE" });
  const { session } = await owner.call<{ session?: { projectPath?: string; worktree?: unknown } }>(
    native ? "native.session.get" : "session.get", { id: sessionId, messageLimit: 1 },
  );
  if (getOwner?.() !== owner) throw Object.assign(new Error("session source replaced"), { errorCode: "HOST_UNAVAILABLE" });
  if (!session) throw Object.assign(new Error("session not found"), { errorCode: "NOT_FOUND" });
  return session;
}

/** Retained file views authorize against their own durable session, not the selected project. */
export async function remoteWorkspaceForFiles(getHost: () => FileHost | null, sessionId?: string, getSidecar?: () => FileHost | null): Promise<RemoteWorkspace | null> {
  const owner = getHost();
  if (!owner) throw new Error("host unavailable");
  let path: string | undefined;
  if (sessionId) {
    const session = await sessionForFiles(getHost, sessionId, getSidecar);
    path = session.projectPath;
  } else {
    const { workspace } = await owner.call<{ workspace?: { path: string } }>("workspace.get");
    path = workspace?.path;
  }
  if (getHost() !== owner) throw Object.assign(new Error("host replaced"), { errorCode: "HOST_UNAVAILABLE" });
  if (!path?.startsWith("remote-project:")) return null;
  const { groups } = await owner.call<{ groups: ProjectGroupRecord[] }>("project.groups.list");
  if (getHost() !== owner) throw Object.assign(new Error("host replaced"), { errorCode: "HOST_UNAVAILABLE" });
  const remote = groups.find((group) => group.primaryPath === path)?.remote;
  if (!remote) throw Object.assign(new Error("remote workspace binding unavailable"), { errorCode: "NOT_FOUND" });
  return remote;
}
