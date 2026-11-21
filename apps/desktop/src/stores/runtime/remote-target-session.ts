import i18n from "i18next";
import { isGlobalPermissionMode, normalizeGlobalPermissionMode } from "@pi-desktop/shared";
import { safeSessionSummary } from "../../lib/remote-session-safety";
import { api } from "../../lib/api";
import { useSessionTargetStore } from "../../features/chat/session-target/session-target-store";
import type { PersistSessionOptions } from "./session-coordination";
import type { SessionRuntime } from "./session-runtime";
import type { StoreAccess } from "../slices/types";

export async function materializeRemoteTargetSession(
  { get, set }: StoreAccess,
  runtime: SessionRuntime,
  persist: (options?: PersistSessionOptions) => Promise<string | null>,
) {
  const { environmentId, repository, baseBranch, remoteProject, folderProject } = useSessionTargetStore.getState();
  const initial = get();
  const intent = runtime.beginNavigationIntent();

  if (!repository) {
    const { environments } = await api.listEnvironments();
    if (!runtime.navigationIntentIsCurrent(intent)) return null;
    const environment = environments.find((entry) => entry.id === environmentId);
    if (!environment) throw new Error(i18n.t("sessionTarget.environmentUnavailable"));
    if (folderProject?.hostKey === environment.hostKey) {
      const workspace = await get().activateProject(folderProject.path, { navigationIntent: intent });
      if (!runtime.navigationIntentIsCurrent(intent)) return null;
      if (!workspace) throw new Error(i18n.t("errors.workspaceActivationFailed"));
      return persist({ intent, projectPath: folderProject.path });
    }
    const projectId = remoteProject?.hostKey === environment.hostKey
      ? remoteProject.projectId
      : undefined;
    const requestedMode = initial.draftConfiguration?.mode ?? initial.settings?.defaultMode;
    const mode = requestedMode === "plan" ? "plan" : requestedMode === "goal" ? "goal" : "agent";
    const draftPermissionMode = initial.draftConfiguration?.permissionMode;
    const permissionMode = isGlobalPermissionMode(draftPermissionMode)
      ? draftPermissionMode
      : normalizeGlobalPermissionMode(initial.settings?.defaultPermissionMode, "ask");
    const { session: created } = await api.createRemoteSession({
      hostKey: environment.hostKey,
      projectId,
      mode,
      permissionMode,
    });
    const session = safeSessionSummary(created);
    set((state) => ({
      sessions: [session, ...state.sessions.filter((item) => item.id !== session.id)],
    }));
    if (!runtime.navigationIntentIsCurrent(intent)) return null;
    await get().selectSession(session.id, { navigationIntent: intent });
    return runtime.navigationIntentIsCurrent(intent) && get().activeSessionId === session.id
      ? session.id
      : null;
  }

  if (!baseBranch) throw new Error(i18n.t("sessionTarget.branchRequired"));
  const { projectPath } = await api.resolveRemoteSessionTarget({
    environmentId, repository: { owner: repository.owner, name: repository.name }, defaultBranch: repository.defaultBranch,
  });
  if (!runtime.navigationIntentIsCurrent(intent)) return null;
  if (!await get().activateProject(projectPath, { navigationIntent: intent })) return null;
  if (!runtime.navigationIntentIsCurrent(intent)) return null;
  const existing = initial.sessions.find((item) => item.id === initial.activeSessionId);
  const reuse = existing?.projectPath === projectPath && !existing.remoteRepository
    && !initial.messages.length && !initial.runningSessions[existing.id];
  const sessionId = reuse ? existing.id : await persist({ intent, projectPath, deferRemoteWorkspace: true });
  if (!sessionId || !runtime.navigationIntentIsCurrent(intent)) return null;
  const { remoteRepository } = await api.startRemoteSessionWorkspace({ sessionId, environmentId, repository, baseBranch });
  set((state) => ({
    sessions: state.sessions.map((session) =>
      session.id === sessionId && !session.remoteRepository ? { ...session, remoteRepository } : session),
  }));
  return sessionId;
}
