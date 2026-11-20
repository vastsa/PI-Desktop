import i18n from "i18next";
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
  const { environmentId, repository, baseBranch } = useSessionTargetStore.getState();
  if (!repository || !baseBranch) throw new Error(i18n.t("sessionTarget.repositoryRequired"));
  const initial = get();
  const intent = runtime.beginNavigationIntent();
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
